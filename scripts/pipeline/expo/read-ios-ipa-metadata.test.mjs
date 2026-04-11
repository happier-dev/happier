import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readIosIpaMetadata } from './read-ios-ipa-metadata.mjs';

test('readIosIpaMetadata reads Info.plist fields from a zipped ipa', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ios-ipa-'));
  const payloadDir = path.join(tempDir, 'Payload', 'Happier.app');
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.happier.app</string>
  <key>CFBundleDisplayName</key>
  <string>Happier</string>
  <key>CFBundleShortVersionString</key>
  <string>1.2.3</string>
  <key>CFBundleVersion</key>
  <string>456</string>
</dict>
</plist>
`,
  );

  const ipaPath = path.join(tempDir, 'Happier.ipa');
  execFileSync('zip', ['-qr', ipaPath, 'Payload'], { cwd: tempDir, stdio: 'ignore' });

  assert.deepEqual(readIosIpaMetadata({ ipaPath, env: { ...process.env } }), {
    bundleIdentifier: 'dev.happier.app',
    displayName: 'Happier',
    version: '1.2.3',
    buildNumber: '456',
  });
});

test('readIosIpaMetadata cleans up temporary plist extraction directories after plutil reads', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ios-ipa-'));
  const payloadDir = path.join(tempDir, 'Payload', 'Happier.app');
  fs.mkdirSync(payloadDir, { recursive: true });

  fs.writeFileSync(
    path.join(payloadDir, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.happier.app</string>
  <key>CFBundleDisplayName</key>
  <string>Happier</string>
  <key>CFBundleShortVersionString</key>
  <string>1.2.3</string>
  <key>CFBundleVersion</key>
  <string>456</string>
</dict>
</plist>
`,
  );

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-fake-plutil-'));
  const plutilPath = path.join(binDir, 'plutil');
  fs.writeFileSync(
    plutilPath,
    `#!/usr/bin/env bash
set -euo pipefail
key="$2"
case "$key" in
  CFBundleIdentifier) printf '%s' 'dev.happier.app' ;;
  CFBundleDisplayName) printf '%s' 'Happier' ;;
  CFBundleName) printf '%s' 'Happier' ;;
  CFBundleShortVersionString) printf '%s' '1.2.3' ;;
  CFBundleVersion) printf '%s' '456' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );

  const ipaPath = path.join(tempDir, 'Happier.ipa');
  execFileSync('zip', ['-qr', ipaPath, 'Payload'], { cwd: tempDir, stdio: 'ignore' });

  const before = new Set(
    fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('happier-ipa-info-')),
  );

  assert.deepEqual(
    readIosIpaMetadata({
      ipaPath,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    }),
    {
      bundleIdentifier: 'dev.happier.app',
      displayName: 'Happier',
      version: '1.2.3',
      buildNumber: '456',
    },
  );

  const after = new Set(
    fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('happier-ipa-info-')),
  );

  assert.deepEqual(after, before);
});
