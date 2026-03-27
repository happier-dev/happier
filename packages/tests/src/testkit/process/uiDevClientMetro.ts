import { mkdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { reserveAvailablePort } from '../network/reserveAvailablePort';
import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from './processOwnershipLease';
import { spawnLoggedProcess } from './spawnProcess';

export type StartedUiDevClientMetro = Readonly<{
  baseUrl: string;
  port: number;
  stdoutPath: string;
  stderrPath: string;
  stop: () => Promise<void>;
}>;

function looksLikeUiDevClientMetroCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('start')
    && normalized.includes('--dev-client')
    && (normalized.includes('/expo/bin/cli') || normalized.includes('expo') || normalized.includes('node'));
}

export function resolveUiDevClientMetroOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'ui-dev-client-metro' });
}

async function isMetroPackagerReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const body = await res.text().catch(() => '');
    return body.includes('packager-status:running');
  } catch {
    return false;
  }
}

export async function startUiDevClientMetro(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
}): Promise<StartedUiDevClientMetro> {
  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await sweepProcessOwnershipLeases({
      rootDir: repoRootDir(),
      leaseKind: 'ui-dev-client-metro',
      currentOwnerPid: process.pid,
      currentOwnerStartTime: currentOwnerInspection.startTime,
      isOwnedProcessCommand: (command) => looksLikeUiDevClientMetroCommand(command),
    });
  }

  const stdoutPath = resolvePath(params.testDir, 'ui.dev-client.metro.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'ui.dev-client.metro.stderr.log');

  const clearRaw = (params.env.HAPPIER_E2E_EXPO_CLEAR ?? '').toString().trim().toLowerCase();
  const clearCache = clearRaw === '1' || clearRaw === 'true' || clearRaw === 'yes' || clearRaw === 'y';

  const expoCliPath = resolvePath(repoRootDir(), 'node_modules', 'expo', 'bin', 'cli');
  const uiWorkspaceDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const tmpDir = resolvePath(params.testDir, 'ui.dev-client.metro.tmp');
  await mkdir(tmpDir, { recursive: true });

  const metroPort =
    typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
      ? params.port
      : await reserveAvailablePort();

  const proc = spawnLoggedProcess({
    command: process.execPath,
    args: [
      expoCliPath,
      'start',
      '--dev-client',
      '--host',
      'localhost',
      '--port',
      String(metroPort),
      ...(clearCache ? ['--clear'] : []),
    ],
    cwd: uiWorkspaceDir,
    env: {
      ...params.env,
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      BROWSER: 'none',
      TMPDIR: tmpDir,
      TMP: tmpDir,
      TEMP: tmpDir,
    },
    stdoutPath,
    stderrPath,
  });

  await registerProcessOwnershipLease({
    rootDir: repoRootDir(),
    leaseKind: 'ui-dev-client-metro',
    child: proc.child,
    ownerPid: process.pid,
    ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
    metadata: {
      port: metroPort,
      testDir: params.testDir,
    },
  });

  const baseUrl = `http://127.0.0.1:${metroPort}`;

  try {
    const exitedEarly = new Promise<never>((_, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
        reject(new Error(`expo dev-client metro exited before ready (${detail})`));
      };
      proc.child.once('exit', onExit);
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        proc.child.off('exit', onExit);
        onExit(proc.child.exitCode, proc.child.signalCode as NodeJS.Signals | null);
      }
    });

    await Promise.race([
      waitFor(async () => await isMetroPackagerReady(baseUrl), {
        timeoutMs: 180_000,
        intervalMs: 250,
        context: 'dev-client metro /status ready',
      }),
      exitedEarly,
    ]);
  } catch (error) {
    await proc.stop().catch(() => {});
    throw error;
  }

  return {
    baseUrl,
    port: metroPort,
    stdoutPath,
    stderrPath,
    stop: async () => {
      await proc.stop().catch(() => {});
    },
  };
}
