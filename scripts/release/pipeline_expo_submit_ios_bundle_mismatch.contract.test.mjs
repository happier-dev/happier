import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo-submit fails when iOS archive bundle id does not match requested environment', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-submit-bundle-'));
  const artifact = path.join(tmp, 'app.ipa');

  const pythonScript = [
    'import sys, zipfile',
    'ipa_path = sys.argv[1]',
    'bundle_id = sys.argv[2]',
    'plist = f"""<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>CFBundleIdentifier</key><string>{bundle_id}</string>',
    '<key>CFBundleDisplayName</key><string>Happier (preview)</string>',
    '<key>CFBundleShortVersionString</key><string>0.1.0</string>',
    '<key>CFBundleVersion</key><string>48</string>',
    '</dict></plist>"""',
    'with zipfile.ZipFile(ipa_path, "w") as z:',
    '  z.writestr("Payload/Happierpreview.app/Info.plist", plist)',
  ].join('\n');

  execFileSync(
    'python3',
    [
      '-c',
      pythonScript,
      artifact,
      'dev.happier.app.preview',
    ],
    { cwd: repoRoot, stdio: 'ignore', timeout: 30_000 },
  );

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'submit.mjs'),
          '--environment',
          'production',
          '--platform',
          'ios',
          '--profile',
          'production',
          '--path',
          artifact,
          '--dry-run',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, EXPO_TOKEN: '' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    (err) => {
      assert.equal(typeof err, 'object');
      const stderr = /** @type {any} */ (err).stderr?.toString?.() ?? '';
      assert.match(stderr, /bundle identifier/i);
      assert.match(stderr, /dev\.happier\.app\.preview/);
      assert.match(stderr, /production/);
      return true;
    },
  );
});
