// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main() {
  const { values } = parseArgs({
    options: {
      'config-path': { type: 'string', default: 'apps/ui/src-tauri/tauri.conf.json' },
    },
    allowPositionals: false,
  });

  const configPath = String(values['config-path'] ?? '').trim() || 'apps/ui/src-tauri/tauri.conf.json';
  const resolved = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    fail(`Tauri config file not found: ${configPath}`);
  }

  let conf;
  try {
    conf = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    fail(`Failed to parse Tauri config JSON: ${configPath}`);
  }

  const pubkey = conf?.plugins?.updater?.pubkey;
  const placeholder = 'REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY_PEM';
  if (typeof pubkey !== 'string' || pubkey.trim().length === 0 || pubkey.includes(placeholder)) {
    console.error(
      `Invalid Tauri updater public key in ${configPath} (still contains "${placeholder}").`,
    );
    console.error('Refusing to build production desktop artifacts until a real updater public key is configured.');
    process.exit(1);
  }
}

main();

