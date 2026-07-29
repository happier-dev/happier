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
import { resolveExpoCliPath } from './expoCliPath';
import { inspectMetroPackagerStatusResponse } from './metroPackagerStatus';

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

export function resolveUiDevClientMetroLaunchSpec(params: Readonly<{
  rootDir: string;
  uiWorkspaceDir: string;
  port: number;
  host: string;
  clearCache: boolean;
}>): Readonly<{
  command: string;
  args: string[];
  cwd: string;
}> {
  return {
    command: process.execPath,
    args: [
      resolveExpoCliPath({
        rootDir: params.rootDir,
        uiWorkspaceDir: params.uiWorkspaceDir,
      }),
      'start',
      '--dev-client',
      '--host',
      params.host,
      '--port',
      String(params.port),
      ...(params.clearCache ? ['--clear'] : []),
    ],
    cwd: params.uiWorkspaceDir,
  };
}

export function resolveUiDevClientMetroProbeBaseUrl(params: Readonly<{
  host: string;
  port: number;
}>): string {
  const probeHost = params.host === 'localhost' ? 'localhost' : '127.0.0.1';
  return `http://${probeHost}:${params.port}`;
}

async function isMetroPackagerReady(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    const inspection = await inspectMetroPackagerStatusResponse(res);
    return inspection.outcome === 'ready';
  } catch {
    return false;
  }
}

export const __testables = {
  isMetroPackagerReady,
};

export async function startUiDevClientMetro(params: {
  testDir: string;
  env: NodeJS.ProcessEnv;
  port?: number;
  host?: string;
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

  const uiWorkspaceDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const tmpDir = resolvePath(params.testDir, 'ui.dev-client.metro.tmp');
  await mkdir(tmpDir, { recursive: true });

  const metroPort =
    typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
      ? params.port
      : await reserveAvailablePort();
  const metroHost = String(params.host ?? '').trim() || 'localhost';

  const launchSpec = resolveUiDevClientMetroLaunchSpec({
    rootDir: repoRootDir(),
    uiWorkspaceDir,
    port: metroPort,
    host: metroHost,
    clearCache,
  });
  const proc = spawnLoggedProcess({
    ...launchSpec,
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

  const baseUrl = resolveUiDevClientMetroProbeBaseUrl({
    host: metroHost,
    port: metroPort,
  });

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
