const $ = (selector) => document.querySelector(selector);

const icons = {
    "moon-star":
        '<svg viewBox="0 0 24 24"><path d="M12 3a7 7 0 1 0 8.2 8.9A6 6 0 1 1 12 3Z"/><path d="m19 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></svg>',
    "sun-line":
        '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="m5.6 5.6 1.4 1.4"/><path d="m17 17 1.4 1.4"/><path d="m18.4 5.6-1.4 1.4"/><path d="m7 17-1.4 1.4"/></svg>',
    qibla:
        '<svg viewBox="0 0 24 24"><path d="M12 3 4 11l8 10 8-10-8-8Z"/><path d="M12 7v10"/><path d="M8.5 11h7"/></svg>',
    "prayer-mat":
        '<svg viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M9 20v-7a3 3 0 0 1 6 0v7"/><path d="M8 7h8"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M12 3a7.5 7.5 0 1 0 8.3 10.9A6.4 6.4 0 1 1 12 3Z"/></svg>',
    sparkles:
        '<svg viewBox="0 0 24 24"><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z"/><path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/></svg>',
};

let currentState;
let ticker;
let didRequestStartupPermissions = false;
let loadingDepth = 0;

const prayerLabels = {
    Fajr: "Fajr",
    Dhuhr: "Dhuhr",
    Asr: "Asr",
    Maghrib: "Maghrib",
    Isha: "Isha",
};

function ensureSelectOption(select, value) {
    if (!value || [...select.options].some((option) => option.value === value))
        return;
    select.add(new Option(value, value));
}

function formatTime12(time) {
    const [hour, minute] = String(time || "")
        .split(":")
        .map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute))
        return time || "--:--";
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatCountdown(dateIso) {
    if (!dateIso) return "No upcoming event today";
    const diff = new Date(dateIso).getTime() - Date.now();
    if (diff <= 0) return "Starting now";
    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

function countdownTarget(event) {
    return event?.countdownDate || event?.date;
}

function countdownLabel(event) {
    if (event) return "Next prayer in";
    return "Next prayer in";
}

function eventDescriptor(event) {
    const labels = {
        prayer: "Prayer time",
    };
    return labels[event.type] || "Daily marker";
}

function recordForPrayer(records, prayer) {
    return records.find((record) => record.prayer === prayer) || {};
}

function getTodayPrompt(events = [], records = []) {
    const doneCount = records.filter((record) => record.done).length;
    const now = Date.now();
    const prayers = events.filter((event) => prayerLabels[event.key]);
    const missed = prayers.filter(
        (event) =>
            new Date(event.date).getTime() < now &&
            !recordForPrayer(records, event.key).done,
    );
    const nextUndone = prayers.find(
        (event) =>
            new Date(event.date).getTime() >= now &&
            !recordForPrayer(records, event.key).done,
    );
    const activeDone = prayers.find((event) => {
        const startsAt = new Date(event.date).getTime();
        const activeUntil = new Date(event.activeUntil).getTime();
        return (
            startsAt <= now &&
            now < activeUntil &&
            recordForPrayer(records, event.key).done
        );
    });

    if (doneCount === 5) {
        return {
            title: "All five done. Well done.",
            message: "Rest easy tonight. May tomorrow be even better.",
        };
    }

    if (activeDone) {
        return {
            title: `${activeDone.label} done. Keep going.`,
            message: "Good. Do not relax too much now, the next prayer still deserves your best.",
        };
    }

    if (!missed.length && nextUndone) {
        return {
            title: "Bismillah, keep your day close to salah.",
            message: `${nextUndone.label} is next at ${formatTime12(nextUndone.time)}. Get ready before the time comes.`,
        };
    }

    if (missed.length) {
        const latest = missed[missed.length - 1];
        const missedNames = missed.map((event) => event.label).join(", ");
        let message =
            "Astaghfirullah, how many times must I tell you? Go pray first, then come back and mark it done.";

        if (missed.length === 1 && latest.key === "Fajr") {
            message =
                "Fajr already passed. Wake up properly, go pray now, then mark it done.";
        } else if (missed.length === 1) {
            message = `${latest.label} passed already. Do not delay like this, go pray now.`;
        } else if (missed.length === 2) {
            message = `${missedNames} both passed. Enough waiting, go settle your prayers now.`;
        } else if (missed.length >= 4) {
            message =
                "Almost the whole day passed. I am not joking, leave everything and go pray.";
        }

        return {
            title: `${latest.label} time passed. Come on.`,
            message,
        };
    }

    return {
        title: "Bismillah, start your day steady.",
        message: "Mark each prayer when it is done.",
    };
}

function renderTodayProgress(events = [], records = []) {
    const doneCount = records.filter((record) => record.done).length;
    const prompt = getTodayPrompt(events, records);
    $("#todayProgress").textContent = `${doneCount}/5`;
    $("#todayProgressFill").style.width = `${doneCount * 20}%`;
    $("#todayTitle").textContent = prompt.title;
    $("#todayMessage").textContent = prompt.message;
}

function render(state) {
    currentState = state;
    const next = state.nextEvent;
    $("#nextLabel").textContent = next?.label || "Ready";
    $("#nextTime").textContent = next ? formatTime12(next.time) : "--:--";
    $("#nextIcon").innerHTML = icons[next?.icon || "moon-star"];
    $("#countdownLabel").textContent = countdownLabel(next);
    $("#countdown").textContent = next
        ? formatCountdown(countdownTarget(next))
        : "No more events today";

    ensureSelectOption($("#country"), state.settings.country);
    ensureSelectOption($("#timezone"), state.settings.timezone);
    $("#country").value = state.settings.country;
    $("#city").value = state.settings.city;
    $("#timezone").value = state.settings.timezone;
    $("#method").value = String(state.settings.method);
    $("#soundEnabled").checked = state.settings.soundEnabled;
    $("#notificationsEnabled").checked = state.settings.notificationsEnabled;
    $("#alertLeadMinutes").value = state.settings.alertLeadMinutes;
    $("#settingsSummary").textContent =
        `${state.settings.city}, ${state.settings.country}`;
    renderTodayProgress(state.events, state.todayPrayerRecords || []);

    $("#timeline").innerHTML = state.events
        .map(
            (event) => {
                const record = recordForPrayer(
                    state.todayPrayerRecords || [],
                    event.key,
                );
                return `
    <article class="event ${event.key === next?.key ? "active" : ""} ${record.done ? "done" : ""}">
      <label class="event-check" title="Mark ${event.label} as done">
        <input type="checkbox" data-prayer-done="${event.key}" ${record.done ? "checked" : ""} />
        <span aria-hidden="true"></span>
      </label>
      <div class="event-icon">${icons[event.icon] || icons["moon-star"]}</div>
      <div>
        <h2>${event.label}</h2>
        <p>${eventDescriptor(event)}</p>
      </div>
      <strong>${formatTime12(event.time)}</strong>
    </article>
  `;
            },
        )
        .join("");

    const updated = state.lastUpdated
        ? new Date(state.lastUpdated).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
          })
        : "Not updated yet";
    $("#status").textContent = state.error ? state.error : `Updated ${updated}`;

    clearInterval(ticker);
    ticker = setInterval(() => {
        if (currentState?.nextEvent)
            $("#countdown").textContent = formatCountdown(
                countdownTarget(currentState.nextEvent),
            );
    }, 1000);
}

function setLoading(isLoading, message = "Updating timings...") {
    loadingDepth = Math.max(0, loadingDepth + (isLoading ? 1 : -1));
    const active = loadingDepth > 0;

    document.body.classList.toggle("is-loading", active);
    $(".app-shell").setAttribute("aria-busy", String(active));
    $("#status").textContent = active ? message : $("#status").textContent;
    $("#refreshButton").disabled = active;
    $("#testSound").disabled = active;
    for (const control of document.querySelectorAll(
        ".settings input, .settings select, .toolbar input, .toolbar select, .timeline input",
    )) {
        control.disabled = active;
    }
}

async function saveFromForm() {
    setLoading(true);
    try {
        const state = await window.prayerTimer.saveSettings({
            country: $("#country").value,
            city: $("#city").value.trim() || "Kuala Lumpur",
            timezone: $("#timezone").value,
            method: Number($("#method").value),
            soundEnabled: $("#soundEnabled").checked,
            notificationsEnabled: $("#notificationsEnabled").checked,
            alertLeadMinutes: Number($("#alertLeadMinutes").value) || 10,
        });
        render(state);
    } finally {
        setLoading(false);
    }
}

function getCurrentPosition() {
    return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) {
            reject(new Error("Location access is not available on this device."));
            return;
        }

        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            maximumAge: 15 * 60 * 1000,
            timeout: 15000,
        });
    });
}

async function requestNotificationAccess() {
    return window.prayerTimer.requestNotifications();
}

async function requestStartupPermissions() {
    if (didRequestStartupPermissions) return;
    didRequestStartupPermissions = true;

    $("#status").textContent = "Requesting notification access...";
    await requestNotificationAccess();

    $("#status").textContent = "Requesting location access...";
    try {
        const position = await getCurrentPosition();
        const detected = await window.prayerTimer.reverseGeocode({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
        });
        const timezone =
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            currentState.settings.timezone;
        const state = await window.prayerTimer.saveSettings({
            ...currentState.settings,
            ...detected,
            timezone,
        });
        render(state);
        $("#status").textContent = `Configured for ${detected.city}, ${detected.country}.`;
    } catch (error) {
        $("#status").textContent =
            error.message || "Location access was not granted.";
    }
}

for (const selector of [
    "#country",
    "#timezone",
    "#method",
    "#soundEnabled",
    "#notificationsEnabled",
    "#alertLeadMinutes",
]) {
    $(selector).addEventListener("change", saveFromForm);
}

$("#city").addEventListener("change", saveFromForm);
$("#refreshButton").addEventListener("click", async () => {
    setLoading(true, "Refreshing timings...");
    try {
        render(await window.prayerTimer.refresh());
    } finally {
        setLoading(false);
    }
});
$("#testSound").addEventListener("click", async () => {
    const result = await window.prayerTimer.testSound();
    $("#status").textContent = result?.reason || "Test notification sent.";
});
$("#timeline").addEventListener("change", async (event) => {
    const target = event.target;
    const prayer = target.dataset.prayerDone;
    if (!prayer) return;

    const state = await window.prayerTimer.updateTodayPrayer({
        prayer,
        done: target.checked,
    });
    render(state);
    $("#status").textContent = "Today record saved.";
});
$("#apiLink").addEventListener("click", () => window.prayerTimer.openApiDocs());
$("#quitButton").addEventListener("click", () => window.prayerTimer.quit());

window.prayerTimer.onState(render);
window.prayerTimer.onRequestPermissions(requestStartupPermissions);
window.prayerTimer.getState().then((state) => {
    render(state);
});
