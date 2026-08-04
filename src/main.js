const {
    app,
    BrowserWindow,
    Tray,
    nativeImage,
    ipcMain,
    Notification,
    nativeTheme,
    session,
    shell,
} = require("electron");
const path = require("path");
const fs = require("fs/promises");

const APP_LOGO_PATH = path.join(
    __dirname,
    "..",
    "public",
    "assets",
    "brand",
    "logo-ios",
    "apple-devices",
    "AppIcon.appiconset",
    "icon-ios-1024x1024.png",
);
const TRAY_LOGO_LIGHT_PATH = path.join(
    __dirname,
    "..",
    "public",
    "assets",
    "brand",
    "logo-menubar-light.png",
);
const TRAY_LOGO_DARK_PATH = path.join(
    __dirname,
    "..",
    "public",
    "assets",
    "brand",
    "logo-menubar-dark.png",
);

const DEFAULT_SETTINGS = {
    city: "Kuala Lumpur",
    country: "Malaysia",
    timezone: "Asia/Kuala_Lumpur",
    method: 3,
    alertLeadMinutes: 10,
    soundEnabled: true,
    notificationsEnabled: true,
};

app.setName("NoorTime");

const PRAYER_KEYS = new Set(["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"]);
const ACTIVE_PRAYER_WINDOW_MS = 60 * 60 * 1000;
const DISPLAY_EVENTS = [
    {
        key: "Fajr",
        label: "Fajr",
        type: "prayer",
        icon: "moon-star",
        isPrayer: true,
    },
    {
        key: "Dhuhr",
        label: "Dhuhr",
        type: "prayer",
        icon: "sun-line",
        isPrayer: true,
    },
    {
        key: "Asr",
        label: "Asr",
        type: "prayer",
        icon: "prayer-mat",
        isPrayer: true,
    },
    {
        key: "Maghrib",
        label: "Maghrib",
        type: "prayer",
        icon: "moon",
        isPrayer: true,
    },
    {
        key: "Isha",
        label: "Isha",
        type: "prayer",
        icon: "moon-star",
        isPrayer: true,
    },
];

let tray;
let panelWindow;
let soundWindow;
let state = {
    settings: { ...DEFAULT_SETTINGS },
    timings: null,
    events: [],
    nextEvent: null,
    lastUpdated: null,
    error: null,
};
let alertTimers = [];
let didOpenPermissionSetup = false;

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

async function loadSettings() {
    try {
        const raw = await fs.readFile(settingsPath(), "utf8");
        state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
        state.settings = { ...DEFAULT_SETTINGS };
    }
}

async function saveSettings(settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...settings };
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(settingsPath(), JSON.stringify(state.settings, null, 2));
}

function stripTime(raw) {
    return String(raw || "")
        .replace(/\s*\(.+\)\s*$/, "")
        .trim();
}

function formatTime12(time) {
    const [hour, minute] = stripTime(time).split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return stripTime(time);
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function zonedDateForTime(time, timezone, baseDate = new Date()) {
    const [hour, minute] = stripTime(time).split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    })
        .formatToParts(baseDate)
        .reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

    const utcGuess = new Date(
        Date.UTC(
            Number(parts.year),
            Number(parts.month) - 1,
            Number(parts.day),
            hour,
            minute,
        ),
    );
    const localParts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    })
        .formatToParts(utcGuess)
        .reduce((acc, part) => {
            acc[part.type] = part.value;
            return acc;
        }, {});

    const asUtc = Date.UTC(
        Number(localParts.year),
        Number(localParts.month) - 1,
        Number(localParts.day),
        Number(localParts.hour),
        Number(localParts.minute),
    );
    const wantedUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        hour,
        minute,
    );
    return new Date(utcGuess.getTime() + (wantedUtc - asUtc));
}

function normalizeEvents(timings, settings) {
    const events = DISPLAY_EVENTS.map((event) => {
        const time = timings[event.key];
        const date = zonedDateForTime(time, settings.timezone);
        const alertAt =
            event.isPrayer && date
                ? new Date(
                      date.getTime() - settings.alertLeadMinutes * 60 * 1000,
                  ).toISOString()
                : null;

        return {
            ...event,
            time: stripTime(time),
            date: date ? date.toISOString() : null,
            activeUntil: date
                ? new Date(date.getTime() + ACTIVE_PRAYER_WINDOW_MS).toISOString()
                : null,
            alertAt,
        };
    }).filter((event) => event.time && event.date);

    return events;
}

function getNextEvent(events) {
    const now = Date.now();
    const upcoming = events
        .map((event) => ({ ...event, ts: new Date(event.date).getTime() }))
        .filter((event) => event.ts > now)
        .sort((a, b) => a.ts - b.ts);
    const firstTomorrow = events
        .map((event) => {
            const nextDate = new Date(
                new Date(event.date).getTime() + 24 * 60 * 60 * 1000,
            );
            return {
                ...event,
                date: nextDate.toISOString(),
                activeUntil: new Date(
                    nextDate.getTime() + ACTIVE_PRAYER_WINDOW_MS,
                ).toISOString(),
                ts: nextDate.getTime(),
            };
        })
        .sort((a, b) => a.ts - b.ts)[0];
    const countdownEvent = upcoming[0] || firstTomorrow || null;

    const active = events
        .map((event) => ({
            ...event,
            ts: new Date(event.date).getTime(),
            activeUntilTs: new Date(event.activeUntil).getTime(),
        }))
        .filter(
            (event) =>
                event.ts <= now &&
                now < event.activeUntilTs &&
                Number.isFinite(event.activeUntilTs),
        )
        .sort((a, b) => b.ts - a.ts)[0];

    if (active) {
        return {
            ...active,
            isActivePrayer: true,
            countdownDate: countdownEvent?.date || active.date,
        };
    }

    if (upcoming[0]) {
        return {
            ...upcoming[0],
            isActivePrayer: false,
            countdownDate: upcoming[0].date,
        };
    }

    return firstTomorrow
        ? {
              ...firstTomorrow,
              isActivePrayer: false,
              countdownDate: firstTomorrow.date,
          }
        : null;
}

function nextInstance(event) {
    const eventTime = new Date(event.date).getTime();
    if (eventTime > Date.now()) return event;
    const nextDate = new Date(eventTime + 24 * 60 * 60 * 1000);
    return {
        ...event,
        date: nextDate.toISOString(),
        activeUntil: new Date(
            nextDate.getTime() + ACTIVE_PRAYER_WINDOW_MS,
        ).toISOString(),
        alertAt: new Date(
            nextDate.getTime() - state.settings.alertLeadMinutes * 60 * 1000,
        ).toISOString(),
    };
}

async function getPrayerTimes(settings) {
    const params = new URLSearchParams({
        city: settings.city,
        country: settings.country,
        method: String(settings.method),
    });

    if (settings.timezone) params.set("timezonestring", settings.timezone);

    const response = await fetch(
        `https://api.aladhan.com/v1/timingsByCity?${params.toString()}`,
    );
    if (!response.ok)
        throw new Error(`AlAdhan request failed with ${response.status}`);

    const payload = await response.json();
    if (payload.code !== 200 || !payload.data?.timings) {
        throw new Error(
            payload.data ||
                payload.status ||
                "Prayer API returned an unexpected response",
        );
    }

    const timezone = payload.data.meta?.timezone || settings.timezone;
    const nextSettings = { ...settings, timezone };
    const events = normalizeEvents(payload.data.timings, nextSettings);

    return {
        timings: payload.data.timings,
        meta: payload.data.meta,
        date: payload.data.date,
        timezone,
        events,
    };
}

async function refreshPrayerTimes() {
    try {
        const data = await getPrayerTimes(state.settings);
        state = {
            ...state,
            settings: { ...state.settings, timezone: data.timezone },
            timings: data.timings,
            meta: data.meta,
            date: data.date,
            events: data.events,
            nextEvent: getNextEvent(data.events),
            lastUpdated: new Date().toISOString(),
            error: null,
        };
        await saveSettings(state.settings);
        scheduleAlerts();
        updateTrayTitle();
    } catch (error) {
        state.error = error.message;
        updateTrayTitle();
    }

    broadcastState();
    return publicState();
}

async function reverseGeocode({ latitude, longitude }) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error("Location coordinates are unavailable.");
    }

    const params = new URLSearchParams({
        format: "jsonv2",
        lat: String(latitude),
        lon: String(longitude),
        zoom: "10",
        addressdetails: "1",
    });
    const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
        {
            headers: {
                "User-Agent": "NoorTime/1.0.0",
            },
        },
    );

    if (!response.ok) {
        throw new Error(`Location lookup failed with ${response.status}`);
    }

    const payload = await response.json();
    const address = payload.address || {};
    const city =
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county;
    const country = address.country;

    if (!city || !country) {
        throw new Error("Could not detect city and country from this location.");
    }

    return { city, country };
}

function publicState() {
    return {
        settings: state.settings,
        events: state.events,
        nextEvent: state.nextEvent,
        lastUpdated: state.lastUpdated,
        error: state.error,
        date: state.date,
        meta: state.meta,
    };
}

function broadcastState() {
    if (panelWindow && !panelWindow.isDestroyed()) {
        panelWindow.webContents.send("state:updated", publicState());
    }
}

function clearAlerts() {
    for (const timer of alertTimers) clearTimeout(timer);
    alertTimers = [];
}

function scheduleAlerts() {
    clearAlerts();

    const now = Date.now();
    for (const event of state.events.filter((item) => PRAYER_KEYS.has(item.key))) {
        const startsAt = new Date(event.date).getTime();
        const activeUntil = new Date(event.activeUntil).getTime();
        const activeUntilDelay = activeUntil - now;

        if (
            startsAt <= now &&
            activeUntilDelay > 0 &&
            activeUntilDelay <= 24 * 60 * 60 * 1000
        ) {
            alertTimers.push(
                setTimeout(() => {
                    updateTrayTitle();
                    broadcastState();
                }, activeUntilDelay),
            );
        }
    }

    for (const event of state.events
        .filter((item) => PRAYER_KEYS.has(item.key))
        .map(nextInstance)) {
        const alertAt = new Date(event.alertAt).getTime();
        const startsAt = new Date(event.date).getTime();
        const activeUntil = new Date(event.activeUntil).getTime();
        const reminderDelay = alertAt - now;
        const prayerDelay = startsAt - now;
        const activeUntilDelay = activeUntil - now;

        if (reminderDelay > 0 && reminderDelay <= 24 * 60 * 60 * 1000) {
            alertTimers.push(
                setTimeout(() => {
                    if (state.settings.soundEnabled) playChime();
                    if (state.settings.notificationsEnabled) {
                        showNotification({
                            title: `${event.label} is near`,
                            body: `${event.label} starts at ${formatTime12(event.time)} in ${state.settings.city}.`,
                        });
                    }
                }, reminderDelay),
            );
        }

        if (prayerDelay > 0 && prayerDelay <= 24 * 60 * 60 * 1000) {
            alertTimers.push(
                setTimeout(() => {
                    if (state.settings.soundEnabled) playChime();
                    if (state.settings.notificationsEnabled) {
                        showNotification({
                            title: `${event.label} time`,
                            body: `It is time for ${event.label} in ${state.settings.city}.`,
                        });
                    }
                    refreshPrayerTimes();
                }, prayerDelay),
            );
        }

        if (activeUntilDelay > 0 && activeUntilDelay <= 24 * 60 * 60 * 1000) {
            alertTimers.push(
                setTimeout(() => {
                    updateTrayTitle();
                    broadcastState();
                }, activeUntilDelay),
            );
        }
    }
}

function createFallbackIcon() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <rect width="36" height="36" rx="18" fill="#1B2A4A"/>
    <path d="M18 7.5a10.5 10.5 0 1 0 8.9 16.1A8.2 8.2 0 1 1 18 7.5Z" fill="#D4AF37"/>
    <circle cx="25.5" cy="10.5" r="2" fill="#D4AF37"/>
  </svg>`;
    return nativeImage.createFromDataURL(
        `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    );
}

function createAppLogoImage() {
    const logo = nativeImage.createFromPath(APP_LOGO_PATH);
    return logo.isEmpty() ? createFallbackIcon() : logo;
}

function createTrayIcon() {
    const iconPath = nativeTheme.shouldUseDarkColors
        ? TRAY_LOGO_LIGHT_PATH
        : TRAY_LOGO_DARK_PATH;
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
        const fallback = createFallbackIcon().resize({ width: 22, height: 22 });
        return fallback;
    }
    return icon.resize({ width: 22, height: 22 });
}

function updateTrayTitle() {
    if (!tray) return;
    const next = getNextEvent(state.events);
    state.nextEvent = next;
    if (!next) {
        tray.setTitle("Prayers");
        return;
    }
    tray.setTitle(`${next.label} ${formatTime12(next.time)}`);
}

function createPanelWindow() {
    panelWindow = new BrowserWindow({
        width: 420,
        height: 680,
        show: false,
        frame: false,
        resizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        vibrancy: "sidebar",
        backgroundColor: "#fff",
        icon: APP_LOGO_PATH,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    panelWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
    panelWindow.on("blur", () => {
        if (panelWindow && !panelWindow.webContents.isDevToolsOpened())
            panelWindow.hide();
    });
}

function createSoundWindow() {
    soundWindow = new BrowserWindow({
        width: 1,
        height: 1,
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        },
    });
    soundWindow.loadFile(path.join(__dirname, "sound.html"));
}

function allowAppPermissions() {
    session.defaultSession.setPermissionCheckHandler(
        (_webContents, permission) =>
            ["geolocation", "notifications"].includes(permission),
    );
    session.defaultSession.setPermissionRequestHandler(
        (_webContents, permission, callback) => {
            callback(["geolocation", "notifications"].includes(permission));
        },
    );
}

function togglePanel() {
    if (!panelWindow) return;
    if (panelWindow.isVisible()) {
        panelWindow.hide();
        return;
    }

    showPanel();
}

function showPanel() {
    if (!panelWindow || !tray) return;

    const trayBounds = tray.getBounds();
    const windowBounds = panelWindow.getBounds();
    panelWindow.setPosition(
        Math.round(
            trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2,
        ),
        Math.round(trayBounds.y + trayBounds.height + 8),
    );
    panelWindow.show();
    panelWindow.focus();
    broadcastState();
}

function openPermissionSetup() {
    if (didOpenPermissionSetup || !panelWindow || panelWindow.isDestroyed()) {
        return;
    }

    didOpenPermissionSetup = true;
    showPanel();
    panelWindow.webContents.send("permissions:request");
}

function playChime() {
    if (soundWindow && !soundWindow.isDestroyed()) {
        soundWindow.webContents.send("play-chime");
    }
}

function showNotification(options) {
    if (!Notification.isSupported()) {
        return {
            ok: false,
            reason: "Notifications are not supported on this device.",
        };
    }

    const notification = new Notification({
        icon: APP_LOGO_PATH,
        ...options,
    });
    notification.on("failed", (_event, error) => {
        state.error = error || "macOS blocked the notification.";
        broadcastState();
    });
    notification.show();
    return { ok: true };
}

ipcMain.handle("state:get", () => publicState());
ipcMain.handle("settings:save", async (_event, settings) => {
    await saveSettings({ ...state.settings, ...settings });
    return refreshPrayerTimes();
});
ipcMain.handle("prayers:refresh", () => refreshPrayerTimes());
ipcMain.handle("location:reverse", (_event, coords) => reverseGeocode(coords));
ipcMain.handle("notifications:request", () =>
    showNotification({
        title: "NoorTime notifications",
        body: "NoorTime will use notifications for salah reminders.",
    }),
);
ipcMain.handle("sound:test", () => {
    playChime();
    if (!state.settings.notificationsEnabled) {
        return {
            ok: false,
            reason: "Notifications are turned off in NoorTime settings.",
        };
    }

    const result = showNotification({
        title: "NoorTime test",
        body: `Notifications are enabled for ${state.settings.city}.`,
    });

    return result.ok
        ? { ok: true, reason: "Test notification sent." }
        : result;
});
ipcMain.handle("app:openApi", () =>
    shell.openExternal("https://aladhan.com/prayer-times-api"),
);
ipcMain.handle("app:quit", () => {
    app.quit();
    return true;
});

app.whenReady().then(async () => {
    await loadSettings();
    if (app.dock) app.dock.hide();
    allowAppPermissions();
    createPanelWindow();
    createSoundWindow();
    tray = new Tray(createTrayIcon());
    tray.setToolTip("NoorTime");
    tray.on("click", togglePanel);
    nativeTheme.on("updated", () => {
        if (tray) tray.setImage(createTrayIcon());
    });
    await refreshPrayerTimes();
    if (panelWindow.webContents.isLoading()) {
        panelWindow.webContents.once("did-finish-load", () => {
            setTimeout(openPermissionSetup, 500);
        });
    } else {
        setTimeout(openPermissionSetup, 500);
    }
}).catch((error) => {
    console.error("Failed to start NoorTime:", error);
});

app.on("window-all-closed", (event) => event.preventDefault());
app.on("before-quit", clearAlerts);
