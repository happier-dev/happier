import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempPathBin } from '../fs/withTempPathBin';
import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from './processTree';

type WrapperCase = {
  name: string;
  scriptPath: string;
  toolCommandName: string;
  configName: string;
  buildArgs: (configPath: string) => string[];
  extraEnv?: Record<string, string>;
};

const WRAPPER_CASES: WrapperCase[] = [
  {
    name: 'run-vitest-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-vitest-with-heartbeat.mjs',
    toolCommandName: 'yarn',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
  },
  {
    name: 'run-playwright-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-playwright-with-heartbeat.mjs',
    toolCommandName: 'yarn',
    configName: 'playwright.config.mjs',
    buildArgs: (configPath) => ['--config', configPath],
  },
  {
    name: 'run-wsrepl-lima-matrix',
    scriptPath: 'packages/tests/scripts/run-wsrepl-lima-matrix.mjs',
    toolCommandName: 'bash',
    configName: 'wsrepl-vm-name.txt',
    buildArgs: () => ['qa-vm'],
  },
  {
    name: 'apps-ui-with-node-heap-limit',
    scriptPath: 'apps/ui/scripts/withNodeHeapLimit.mjs',
    toolCommandName: 'fake-runner',
    configName: 'noop.config',
    buildArgs: (configPath) => ['fake-runner', configPath],
  },
  {
    name: 'apps-ui-run-vitest-shards',
    scriptPath: 'apps/ui/scripts/runVitestShards.mjs',
    toolCommandName: 'vitest',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
    extraEnv: {
      HAPPIER_UI_VITEST_SHARDS: '1',
    },
  },
  {
    name: 'apps-cli-with-node-heap-limit',
    scriptPath: 'apps/cli/scripts/withNodeHeapLimit.mjs',
    toolCommandName: 'fake-runner',
    configName: 'noop.config',
    buildArgs: (configPath) => ['fake-runner', configPath],
  },
  {
    name: 'apps-cli-run-vitest-shards',
    scriptPath: 'apps/cli/scripts/runVitestShards.mjs',
    toolCommandName: 'vitest',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
    extraEnv: {
      HAPPIER_CLI_VITEST_SHARDS: '1',
    },
  },
];

function createChildProcessExitPromise(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  return once(child, 'exit').then(([code, signal]) => ({
    code: typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
  }));
}

async function createFakeToolchain(
  toolDir: string,
  commandName: string,
  markerPath: string,
  opts?: Readonly<{ exitAfterSpawn?: boolean; signalAfterSpawn?: NodeJS.Signals }>,
): Promise<void> {
  const commandPath = join(toolDir, process.platform === 'win32' ? `${commandName}.cmd` : commandName);
  const sharedScriptPath = join(toolDir, 'fake-yarn.cjs');
  const exitAfterSpawn = opts?.exitAfterSpawn === true;
  const signalAfterSpawn = opts?.signalAfterSpawn;

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
      signalAfterSpawn
        ? `setTimeout(() => process.kill(process.pid, ${JSON.stringify(signalAfterSpawn)}), 25);`
        : exitAfterSpawn
          ? 'process.exit(0);'
          : "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
    'utf8',
  );

  if (process.platform === 'win32') {
    await writeFile(
      commandPath,
      [
        '@echo off',
        `node "${sharedScriptPath}" %*`,
        '',
      ].join('\r\n'),
      'utf8',
    );
  } else {
    await writeFile(
      commandPath,
      [
        '#!/usr/bin/env node',
        "require('./fake-yarn.cjs');",
        '',
      ].join('\n'),
      'utf8',
    );
    await chmod(commandPath, 0o755);
  }
}

async function runWrapperCleanupScenario(
  caseItem: WrapperCase,
  opts?: Readonly<{ exitAfterSpawn?: boolean; signalAfterSpawn?: NodeJS.Signals }>,
): Promise<{ code: number | null; signal: string | null } | void> {
  const wrapperPath = resolve(repoRootDir(), caseItem.scriptPath);

  return await withTempPathBin({ prefix: `happier-heartbeat-${caseItem.name}-` }, async (tempPathBin) => {
    const toolDir = tempPathBin.dir;
    const markerPath = join(toolDir, 'process-marker.json');
    const configPath = join(toolDir, caseItem.configName);
    const env = {
      ...tempPathBin.env,
      HAPPIER_HEARTBEAT_MARKER: markerPath,
      HAPPIER_TEST_HEARTBEAT_MS: '1000',
      HAPPIER_HEARTBEAT_EXIT_AFTER_SPAWN: opts?.exitAfterSpawn === true ? '1' : '',
      ...caseItem.extraEnv,
    };

    await writeFile(configPath, '// test config\n', 'utf8');
    await createFakeToolchain(toolDir, caseItem.toolCommandName, markerPath, opts);

    const child = spawn(process.execPath, [wrapperPath, ...caseItem.buildArgs(configPath)], {
      env,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const childExitPromise = createChildProcessExitPromise(child);

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

      if (opts?.signalAfterSpawn) {
        return await childExitPromise;
      }

      if (opts?.exitAfterSpawn === true) {
        await childExitPromise;
      } else {
        child.kill('SIGTERM');
        await childExitPromise;
      }

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
      await terminateProcessTreeByPid(child.pid ?? 0, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
    }
  });
}

async function runWrapperParentExitCleanupScenario(caseItem: WrapperCase): Promise<void> {
  const wrapperPath = resolve(repoRootDir(), caseItem.scriptPath);

  await withTempPathBin({ prefix: `happier-heartbeat-parent-exit-${caseItem.name}-` }, async (tempPathBin) => {
    const toolDir = tempPathBin.dir;
    const markerPath = join(toolDir, 'process-marker.json');
    const wrapperPidPath = join(toolDir, 'wrapper-pid.json');
    const configPath = join(toolDir, caseItem.configName);
    const launcherPath = join(toolDir, 'launcher.cjs');
    const env = {
      ...tempPathBin.env,
      HAPPIER_HEARTBEAT_MARKER: markerPath,
      HAPPIER_TEST_HEARTBEAT_MS: '1000',
      HAPPIER_WRAPPER_PID_PATH: wrapperPidPath,
      ...caseItem.extraEnv,
    };

    await writeFile(configPath, '// test config\n', 'utf8');
    await createFakeToolchain(toolDir, caseItem.toolCommandName, markerPath);
    await writeFile(
      launcherPath,
      [
        "'use strict';",
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeFileSync } = require('node:fs');",
        "const wrapperPath = process.env.HAPPIER_WRAPPER_PATH;",
        "const wrapperPidPath = process.env.HAPPIER_WRAPPER_PID_PATH;",
        "const configPath = process.env.HAPPIER_WRAPPER_CONFIG;",
        "const rawWrapperArgs = process.env.HAPPIER_WRAPPER_ARGS_JSON;",
        "if (!wrapperPath || !wrapperPidPath || !configPath) throw new Error('Missing wrapper launcher env');",
        "const wrapperArgs = Array.isArray(JSON.parse(rawWrapperArgs || '[]')) ? JSON.parse(rawWrapperArgs || '[]') : [];",
        "const child = spawn(process.execPath, [wrapperPath, ...wrapperArgs], {",
        "  env: process.env,",
        "  stdio: 'ignore',",
        "});",
        "if (!child.pid) throw new Error('Failed to spawn wrapper');",
        "writeFileSync(wrapperPidPath, JSON.stringify({ wrapperPid: child.pid }), 'utf8');",
        "const deadline = Date.now() + 10000;",
        "const poll = () => {",
        "  if (existsSync(process.env.HAPPIER_HEARTBEAT_MARKER)) {",
        "    process.exit(0);",
        "    return;",
        "  }",
        "  if (Date.now() >= deadline) {",
        "    process.exit(2);",
        "    return;",
        "  }",
        "  setTimeout(poll, 50);",
        "};",
        "poll();",
        '',
      ].join('\n'),
      'utf8',
    );

    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...env,
        HAPPIER_WRAPPER_PATH: wrapperPath,
        HAPPIER_WRAPPER_CONFIG: configPath,
        HAPPIER_WRAPPER_ARGS_JSON: JSON.stringify(caseItem.buildArgs(configPath)),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    let wrapperPid = 0;
    let marker: { childPid: number; grandchildPid: number } | null = null;
    try {
      await once(launcher, 'exit');

      await waitFor(async () => {
        try {
          const raw = await readFile(wrapperPidPath, 'utf8');
          const parsed = JSON.parse(raw) as { wrapperPid?: unknown };
          return Number.isInteger(parsed.wrapperPid);
        } catch {
          return false;
        }
      }, { timeoutMs: 10_000, intervalMs: 100, context: `${caseItem.name} wrapper pid capture` });

      const wrapperRaw = await readFile(wrapperPidPath, 'utf8');
      wrapperPid = (JSON.parse(wrapperRaw) as { wrapperPid: number }).wrapperPid;
      expect(wrapperPid).toBeGreaterThan(0);

      await waitFor(async () => {
        try {
          const raw = await readFile(markerPath, 'utf8');
          const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
          return Number.isInteger(parsed.childPid) && Number.isInteger(parsed.grandchildPid);
        } catch {
          return false;
        }
      }, { timeoutMs: 20_000, intervalMs: 100, context: `${caseItem.name} fake yarn startup before parent exit` });

      marker = JSON.parse(await readFile(markerPath, 'utf8')) as { childPid: number; grandchildPid: number };
      expect(marker.childPid).toBeGreaterThan(0);
      expect(marker.grandchildPid).toBeGreaterThan(0);

      await waitFor(() => !isProcessAlive(wrapperPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper shutdown after parent exit`,
      });

      await waitFor(() => !isProcessAlive(marker!.childPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper child shutdown after parent exit`,
      });

      await waitFor(() => !isProcessAlive(marker!.grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper grandchild shutdown after parent exit`,
      });
    } finally {
      await terminateProcessTreeByPid(launcher.pid ?? 0, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      if (wrapperPid > 0) {
        await terminateProcessTreeByPid(wrapperPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
      if (marker?.childPid) {
        await terminateProcessTreeByPid(marker.childPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
      if (marker?.grandchildPid) {
        await terminateProcessTreeByPid(marker.grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
    }
  });
}

describe.each(WRAPPER_CASES)('%s', (caseItem) => {
  it('terminates descendant test processes when the wrapper receives SIGTERM', async () => {
    await runWrapperCleanupScenario(caseItem);
  }, 30_000);

  it('maps child signal exits to canonical shell exit codes', async () => {
    const result = await runWrapperCleanupScenario(caseItem, { signalAfterSpawn: 'SIGTERM' });
    expect(result).toEqual({ code: 143, signal: null });
  }, 30_000);

  it('terminates descendant test processes when the child exits successfully', async () => {
    await runWrapperCleanupScenario(caseItem, { exitAfterSpawn: true });
  }, 30_000);

  it('terminates descendant test processes when the wrapper loses its parent', async () => {
    await runWrapperParentExitCleanupScenario(caseItem);
  }, 30_000);
});
