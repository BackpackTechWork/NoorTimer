const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const required = [
  'src/main.js',
  'src/preload.js',
  'src/sound.html',
  'src/renderer/index.html',
  'src/renderer/renderer.js',
  'src/renderer/styles.css'
];

for (const file of required) {
  const fullPath = path.join(process.cwd(), file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of ['src/main.js', 'src/preload.js', 'src/renderer/renderer.js']) {
  execFileSync(process.execPath, ['--check', path.join(process.cwd(), file)], { stdio: 'inherit' });
}

console.log('Project structure and main process syntax are valid.');
