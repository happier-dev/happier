import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer } from './expo_dev.mjs';

test('ensureDevExpoServer does not drop Expo output when spawnOptions stdio is ignore', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-verbose-'));
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'node_modules'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "console.log('hello-from-fake-expo');",
        "setTimeout(() => process.exit(0), 100);",
      ].join('\n') + '\n',
      'utf-8'
    );
    await chmod(expoBin, 0o755);

    const teeFile = join(tmp, 'expo.log');
    const children = [];
    await ensureDevExpoServer({
      startUi: true,
      startMobile: false,
      uiDir,
      autostart: { baseDir: tmp },
      baseEnv: { ...process.env, HAPPIER_STACK_VERBOSE: '1' },
      apiServerUrl: 'http://127.0.0.1:1',
      restart: true,
      stackMode: false,
      runtimeStatePath: null,
      stackName: 'test',
      envPath: '',
      children,
      spawnOptions: {
        stdio: ['ignore', 'ignore', 'ignore'],
        silent: true,
        teeFile,
        teeLabel: 'expo',
      },
      quiet: true,
    });

    await delay(400);
    const log = await readFile(teeFile, 'utf-8').catch(() => '');
    assert.match(log, /hello-from-fake-expo/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
