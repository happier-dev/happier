import { runManagedChildCommand, resolveSignalExitCode } from '../../../scripts/managedChildLifecycle.mjs';
import { startTestDaemon } from '../daemon/daemon';
import { startServerLight } from '../process/serverLight';
import { startUiDevClientMetro } from '../process/uiDevClientMetro';
import { startCliAuthLoginForTerminalConnect } from '../uiE2e/cliTerminalConnect';

import { runMobileMaestro } from './mobileMaestroRunner';

function elapsedSeconds(startedAtMs: number): number {
  return Math.floor((Date.now() - startedAtMs) / 1000);
}

async function main() {
  const result = await runMobileMaestro(
    {
      argv: process.argv,
      cwd: process.cwd(),
      env: process.env,
    },
    {
      startDevClientMetro: async ({ testDir, extraEnv, port, host }) => {
        const mergedEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...extraEnv,
        };
        const started = await startUiDevClientMetro({ testDir, env: mergedEnv, port, host });
        return {
          baseUrl: started.baseUrl,
          port: started.port,
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
      startCliTerminalConnect: async ({ testDir, cliHomeDir, serverUrl, webappUrl, env }) => {
        return await startCliAuthLoginForTerminalConnect({
          testDir,
          cliHomeDir,
          serverUrl,
          webappUrl,
          env,
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
        // eslint-disable-next-line no-console
        console.log(`[tests] starting: ${maestroBin} ${args.join(' ')}`);

        const heartbeatMs = Number.parseInt(process.env.HAPPIER_TEST_HEARTBEAT_MS ?? '30000', 10);
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
          parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
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
    },
  );

  process.exit(result.exitCode);
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
