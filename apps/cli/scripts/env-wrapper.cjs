#!/usr/bin/env node
/**
 * Cross-platform environment wrapper for Happier CLI
 * Sets HAPPIER_HOME_DIR and provides visual feedback
 *
 * Usage: node scripts/env-wrapper.js <variant> <command> [...args]
 *
 * Variants:
 *   - stable: Production-ready version using ~/.happier/
 *   - dev: Development version using ~/.happier-dev/
 *
 * Examples:
 *   node scripts/env-wrapper.js stable daemon start
 *   node scripts/env-wrapper.js dev auth login
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VARIANTS = {
  stable: {
    homeDir: path.join(os.homedir(), '.happier'),
    color: '\x1b[32m', // Green
    label: '✅ STABLE',
    serverUrl: process.env.HAPPIER_SERVER_URL || 'https://api.happier.dev'
  },
  dev: {
    homeDir: path.join(os.homedir(), '.happier-dev'),
    color: '\x1b[33m', // Yellow
    label: '🔧 DEV',
    serverUrl: process.env.HAPPIER_SERVER_URL || 'https://api.happier.dev'
  }
};

const variant = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (!variant || !VARIANTS[variant]) {
  console.error('Usage: node scripts/env-wrapper.js <stable|dev> <command> [...args]');
  console.error('');
  console.error('Variants:');
  console.error('  stable - Production-ready version (data: ~/.happier/)');
  console.error('  dev    - Development version (data: ~/.happier-dev/)');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.js stable daemon start');
  console.error('  node scripts/env-wrapper.js dev auth login');
  process.exit(1);
}

if (!command) {
  console.error('Usage: node scripts/env-wrapper.js <stable|dev> <command> [...args]');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.js stable daemon start');
  console.error('  node scripts/env-wrapper.js dev auth login');
  process.exit(1);
}

const config = VARIANTS[variant];

// Create home directory if it doesn't exist
if (!fs.existsSync(config.homeDir)) {
  fs.mkdirSync(config.homeDir, { recursive: true });
}

// Visual feedback
console.log(`${config.color}${config.label}\x1b[0m Happier CLI (data: ${config.homeDir})`);

// Set environment and execute command
const env = {
  ...process.env,
  HAPPIER_HOME_DIR: config.homeDir,
  HAPPIER_SERVER_URL: config.serverUrl,
  HAPPIER_VARIANT: variant, // For internal validation
};

// Start from argv on every platform. `shell: true` makes Node concatenate the
// command and arguments into one unescaped command line (Node DEP0190): it splits
// `binPath` at any space and hands these user-supplied arguments straight to a
// shell parser. `process.execPath` is the absolute Node already running this
// wrapper, so there is no bare-name PATH lookup for Windows to need a shell for.
const binPath = path.join(__dirname, '..', 'bin', 'happier.mjs');
const proc = spawn(process.execPath, [binPath, command, ...args], {
  env,
  stdio: 'inherit'
});

proc.on('exit', (code) => process.exit(code || 0));
