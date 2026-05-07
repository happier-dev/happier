import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveInstalledAndroidDevClientRuntimeVersion } from './androidDevClientRuntimeVersion';

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

describe('resolveInstalledAndroidDevClientRuntimeVersion', () => {
  it('reads the installed dev-client fingerprint asset from the Android base APK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-runtime-version-'));
    const commandLog = join(dir, 'commands.log');
    const adbBin = join(dir, 'adb');
    const unzipBin = join(dir, 'unzip');

    writeExecutable(adbBin, `#!/bin/sh
printf 'adb %s\\n' "$*" >> "${commandLog}"
if [ "$1" = "shell" ]; then
  printf 'package:/data/app/example/base.apk\\n'
  exit 0
fi
if [ "$1" = "pull" ]; then
  : > "$3"
  printf 'pulled\\n'
  exit 0
fi
exit 1
`);
    writeExecutable(unzipBin, `#!/bin/sh
printf 'unzip %s\\n' "$*" >> "${commandLog}"
if [ "$1" = "-p" ] && [ "$3" = "assets/fingerprint" ]; then
  printf 'runtime-fingerprint\\n'
  exit 0
fi
exit 11
`);

    const runtimeVersion = resolveInstalledAndroidDevClientRuntimeVersion({
      appId: 'dev.happier.app.publicdev.devclient',
      env: {
        HAPPIER_E2E_ADB_BIN: adbBin,
        HAPPIER_E2E_UNZIP_BIN: unzipBin,
      },
      outputDir: join(dir, 'runtime'),
    });

    expect(runtimeVersion).toBe('runtime-fingerprint');
    expect(readFileSync(commandLog, 'utf8')).toContain(
      'adb shell pm path dev.happier.app.publicdev.devclient',
    );
    expect(readFileSync(commandLog, 'utf8')).toContain(
      `adb pull /data/app/example/base.apk ${join(dir, 'runtime', 'android-dev-client-base.apk')}`,
    );
    expect(readFileSync(commandLog, 'utf8')).toContain(
      `unzip -p ${join(dir, 'runtime', 'android-dev-client-base.apk')} assets/fingerprint`,
    );
  });

  it('returns null when the installed APK has no fingerprint asset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-runtime-version-'));
    const adbBin = join(dir, 'adb');
    const unzipBin = join(dir, 'unzip');

    writeExecutable(adbBin, `#!/bin/sh
if [ "$1" = "shell" ]; then
  printf 'package:/data/app/example/base.apk\\n'
  exit 0
fi
if [ "$1" = "pull" ]; then
  : > "$3"
  exit 0
fi
exit 1
`);
    writeExecutable(unzipBin, `#!/bin/sh
exit 11
`);

    expect(resolveInstalledAndroidDevClientRuntimeVersion({
      appId: 'dev.happier.app.publicdev.devclient',
      env: {
        HAPPIER_E2E_ADB_BIN: adbBin,
        HAPPIER_E2E_UNZIP_BIN: unzipBin,
      },
      outputDir: join(dir, 'runtime'),
    })).toBeNull();
  });
});
