import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runManagedChildCommand, resolveSignalExitCode } from '../../../../../scripts/testing/process/managedChildLifecycle.mjs';
import { startTestDaemon } from '../daemon/daemon';
import { startServerLight } from '../process/serverLight';
import { startUiDevClientMetro } from '../process/uiDevClientMetro';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';

import {
  redactSensitiveMaestroCommandArgsForLog,
  runMobileMaestro,
  type MobileMaestroScenarioContext,
} from './mobileMaestroRunner';

function elapsedSeconds(startedAtMs: number): number {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

export async function runDefaultMobileMaestroCli(input: Readonly<{
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}> = {
  argv: process.argv,
  cwd: process.cwd(),
  env: process.env,
}, options: Readonly<{
  runScenario?: (context: MobileMaestroScenarioContext) => Promise<number>;
}> = {}) {
  return await runMobileMaestro(
    {
      argv: input.argv,
      cwd: input.cwd,
      env: input.env,
    },
    {
      startDevClientMetro: async ({ testDir, extraEnv, port, host }) => {
        const mergedEnv: NodeJS.ProcessEnv = {
          ...input.env,
          ...extraEnv,
        };
        const started = await startUiDevClientMetro({ testDir, env: mergedEnv, port, host });
        return {
          baseUrl: started.baseUrl,
          port: started.port,
          stdoutPath: started.stdoutPath,
          stop: started.stop,
        };
      },
      startServerLight: async ({ testDir, extraEnv }) => {
        const started = await startServerLight({ testDir, extraEnv });
        return {
          baseUrl: started.baseUrl,
          port: started.port,
          dataDir: started.dataDir,
          stop: started.stop,
        };
      },
      startCliTerminalConnect: async ({
        testDir,
        cliHomeDir,
        serverUrl,
        webappUrl,
        env,
        waitForConnectUrlReady,
      }) => {
        return await startCliAuthLoginForTerminalConnect({
          testDir,
          cliHomeDir,
          serverUrl,
          webappUrl,
          env,
          waitForConnectUrlReady,
        });
      },
      startTestDaemon: async ({ testDir, happyHomeDir, env, startupTimeoutMs }) => {
        return await startTestDaemon({
          testDir,
          happyHomeDir,
          env,
          startupTimeoutMs,
        });
      },
      runMaestro: async ({ cwd, env, maestroBin, args }) => {
        const startedAt = Date.now();
        const logArgs = redactSensitiveMaestroCommandArgsForLog(args, env);
        // eslint-disable-next-line no-console
        console.log(`[tests] starting: ${maestroBin} ${logArgs.join(' ')}`);

        const heartbeatMs = Number.parseInt(input.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
        const safeHeartbeatMs = Number.isFinite(heartbeatMs) && heartbeatMs >= 1000 ? heartbeatMs : 30000;
        const heartbeat = setInterval(() => {
          // eslint-disable-next-line no-console
          console.log(`[tests] still running (${elapsedSeconds(startedAt)}s elapsed): maestro`);
        }, safeHeartbeatMs);

        const result = await runManagedChildCommand({
          command: maestroBin,
          args,
          spawnOptions: {
            cwd,
            env,
            stdio: 'inherit',
            detached: process.platform !== 'win32',
          },
          cleanupPollMs: 25,
          signalCleanupGraceMs: 0,
          exitCleanupGraceMs: 1_000,
          parentWatchdogPollMs: Number.parseInt(input.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
        });
        clearInterval(heartbeat);
        if (!result.ok) {
          // eslint-disable-next-line no-console
          console.error(`[tests] failed to start maestro: ${result.error.message}`);
          return { exitCode: 1 };
        }
        const exitCode = typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
        // eslint-disable-next-line no-console
        console.log(`[tests] completed in ${elapsedSeconds(startedAt)}s with code ${exitCode}`);
        return { exitCode };
      },
      ...(options.runScenario ? { runScenario: options.runScenario } : {}),
    },
  );
}

async function main() {
  const result = await runDefaultMobileMaestroCli();
  process.exit(result.exitCode);
}

const currentFilePath = fileURLToPath(import.meta.url);
const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entrypointPath === currentFilePath) {
  void main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
