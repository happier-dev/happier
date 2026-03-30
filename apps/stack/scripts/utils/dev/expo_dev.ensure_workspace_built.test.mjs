import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDevExpoServer } from './expo_dev.mjs';

test('ensureDevExpoServer runs the UI workspace build preflight before starting Expo', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-expo-preflight-'));
  try {
    const uiDir = join(tmp, 'ui');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(uiDir, 'scripts'), { recursive: true });
    await writeFile(join(uiDir, 'package.json'), JSON.stringify({ name: 'fake-ui', private: true }) + '\n', 'utf-8');

    const marker = join(tmp, 'workspace-preflight-ran.txt');
    await writeFile(join(uiDir, 'scripts', 'ensureWorkspacePackagesBuilt.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'ok\\n', 'utf-8');`,
    ].join('\n') + '\n', 'utf-8');

    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await writeFile(
      expoBin,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        "console.log(fs.existsSync(marker) ? 'preflight-ok' : 'preflight-missing');",
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
        silent: true,
        teeFile,
        teeLabel: 'expo',
      },
      quiet: true,
    });

    const deadlineMs = Date.now() + 3000;
    let log = '';
    while (Date.now() < deadlineMs) {
      log = await readFile(teeFile, 'utf-8').catch(() => '');
      if (/preflight-/.test(log)) break;
      await delay(100);
    }

    assert.match(log, /preflight-ok/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

