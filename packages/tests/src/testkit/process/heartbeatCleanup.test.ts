import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from './processTree';

type WrapperCase = {
  name: string;
  scriptPath: string;
  configName: string;
};

const WRAPPER_CASES: WrapperCase[] = [
  {
    name: 'run-vitest-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-vitest-with-heartbeat.mjs',
    configName: 'vitest.config.ts',
  },
  {
    name: 'run-playwright-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-playwright-with-heartbeat.mjs',
    configName: 'playwright.config.mjs',
  },
];

async function createFakeYarnToolchain(toolDir: string, markerPath: string): Promise<void> {
  const yarnPath = join(toolDir, process.platform === 'win32' ? 'yarn.cmd' : 'yarn');
  const sharedScriptPath = join(toolDir, 'fake-yarn.cjs');

  await writeFile(
    sharedScriptPath,
    [
      "'use strict';",
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const markerPath = process.env.HAPPIER_HEARTBEAT_MARKER;",
      "if (!markerPath) throw new Error('Missing HAPPIER_HEARTBEAT_MARKER');",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "if (!grandchild.pid) throw new Error('Failed to spawn descendant process');",
      "writeFileSync(markerPath, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');",
      "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    await writeFile(
      yarnPath,
      [
        '@echo off',
        `node "${sharedScriptPath}" %*`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  } else {
    await writeFile(
      yarnPath,
      [
        '#!/usr/bin/env node',
        "require('./fake-yarn.cjs');",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(yarnPath, 0o755);
  }
}

async function runWrapperCleanupScenario(caseItem: WrapperCase): Promise<void> {
  const toolDir = await mkdtemp(join(tmpdir(), `happier-heartbeat-${caseItem.name}-`));
  const markerPath = join(toolDir, 'process-marker.json');
  const configPath = join(toolDir, caseItem.configName);
  const wrapperPath = resolve(repoRootDir(), caseItem.scriptPath);

  const env = {
    ...process.env,
    HAPPIER_HEARTBEAT_MARKER: markerPath,
    HAPPIER_TEST_HEARTBEAT_MS: '1000',
    PATH: `${toolDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };

  try {
    await writeFile(configPath, '// test config\n', 'utf8');
    await createFakeYarnToolchain(toolDir, markerPath);

    const child = spawn(process.execPath, [wrapperPath, '--config', configPath], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
      await waitFor(async () => {
        try {
          const raw = await readFile(markerPath, 'utf8');
          const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
          return Number.isInteger(parsed.childPid) && Number.isInteger(parsed.grandchildPid);
        } catch {
          return false;
        }
      }, { timeoutMs: 20_000, intervalMs: 100, context: `${caseItem.name} fake yarn startup` });

      const raw = await readFile(markerPath, 'utf8');
      const marker = JSON.parse(raw) as { childPid: number; grandchildPid: number };
      expect(marker.childPid).toBeGreaterThan(0);
      expect(marker.grandchildPid).toBeGreaterThan(0);

      child.kill('SIGTERM');
      await once(child, 'exit');

      await waitFor(() => !isProcessAlive(marker.childPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper child shutdown`,
      });

      await waitFor(() => !isProcessAlive(marker.grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper descendant shutdown`,
      });
    } finally {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      await terminateProcessTreeByPid(child.pid ?? 0, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(toolDir, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(toolDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

describe.each(WRAPPER_CASES)('%s', (caseItem) => {
  it('terminates descendant test processes when the wrapper receives SIGTERM', async () => {
    await runWrapperCleanupScenario(caseItem);
  }, 30_000);
});
