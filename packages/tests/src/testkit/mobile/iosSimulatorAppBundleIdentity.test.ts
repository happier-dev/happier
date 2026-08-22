import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveInstalledIosSimulatorAppBundleIdentity,
} from './iosSimulatorAppBundleIdentity';

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function expectedBundleDigest(entries: readonly Readonly<{
  path: string;
  bytes: string;
}>[]): string {
  const digest = createHash('sha256');
  for (const entry of entries) {
    const bytes = Buffer.from(entry.bytes, 'utf8');
    digest.update(`file\0${entry.path}\0${bytes.byteLength}\0`);
    digest.update(bytes);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

describe('resolveInstalledIosSimulatorAppBundleIdentity', () => {
  it('attests the exact installed app bundle returned for the selected simulator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-ios-app-identity-'));
    const commandLog = join(dir, 'commands.log');
    const appBundle = join(dir, 'Happier.app');
    const xcrunBin = join(dir, 'xcrun');
    mkdirSync(join(appBundle, 'Frameworks'), { recursive: true });
    writeFileSync(join(appBundle, 'Info.plist'), 'plist-v1', 'utf8');
    writeFileSync(join(appBundle, 'Frameworks', 'runtime'), 'runtime-v1', 'utf8');
    writeExecutable(xcrunBin, `#!/bin/sh
printf 'xcrun %s\\n' "$*" >> "$HAPPIER_TEST_COMMAND_LOG"
if [ "$1" = "simctl" ] && [ "$2" = "get_app_container" ] && [ "$5" = "app" ]; then
  printf '%s\\n' "$HAPPIER_TEST_APP_BUNDLE"
  exit 0
fi
exit 1
`);

    const params = {
      appId: 'dev.happier.app.publicdev.devclient',
      deviceId: '70BA62F6-71E9-42BF-A9F4-B656F0610195',
      env: {
        HAPPIER_E2E_XCRUN_BIN: xcrunBin,
        HAPPIER_TEST_APP_BUNDLE: appBundle,
        HAPPIER_TEST_COMMAND_LOG: commandLog,
      },
    };
    const identity = resolveInstalledIosSimulatorAppBundleIdentity(params);

    expect(identity).toEqual({
      appBundleFileSetSha256: expectedBundleDigest([
        { path: 'Frameworks/runtime', bytes: 'runtime-v1' },
        { path: 'Info.plist', bytes: 'plist-v1' },
      ]),
    });
    expect(readFileSync(commandLog, 'utf8')).toContain(
      'xcrun simctl get_app_container 70BA62F6-71E9-42BF-A9F4-B656F0610195 dev.happier.app.publicdev.devclient app',
    );

    writeFileSync(join(appBundle, 'Frameworks', 'runtime'), 'runtime-v2', 'utf8');
    expect(resolveInstalledIosSimulatorAppBundleIdentity(params)).toEqual({
      appBundleFileSetSha256: expectedBundleDigest([
        { path: 'Frameworks/runtime', bytes: 'runtime-v2' },
        { path: 'Info.plist', bytes: 'plist-v1' },
      ]),
    });
  });
});
