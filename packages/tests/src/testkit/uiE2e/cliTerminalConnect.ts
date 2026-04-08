import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { resolveCliTestLaunchSpec } from '../process/cliLaunchSpec';
import { expandLoopbackBaseUrlCandidates } from '../network/loopbackBaseUrl';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from '../process/processOwnershipLease';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { waitForRegexInFile } from '../waitForRegexInFile';

function extractHttpUrls(text: string): string[] {
  const out: string[] = [];
  const pattern = /\bhttps?:\/\/[^\s)]+/g;
  for (const match of text.matchAll(pattern)) {
    const url = match[0];
    if (!url) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function normalizeUrl(raw: string): string {
  return raw.replaceAll(/\u001b\[[0-9;]*m/g, '').trim().replace(/^[('"]+/, '').replace(/[)'".,]+$/, '');
}

function looksLikeCliTerminalConnectCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('auth login')
    && normalized.includes('--force')
    && normalized.includes('--no-open')
    && normalized.includes('--method web');
}

export function resolveCliTerminalConnectOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'cli-terminal-connect' });
}

function extractTerminalConnectUrl(text: string): string | null {
  for (const raw of extractHttpUrls(text)) {
    const cleaned = normalizeUrl(raw);
    if (!cleaned.includes('/terminal/connect#key=')) continue;
    return cleaned;
  }
  return null;
}

async function stdoutTail(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.slice(Math.max(0, raw.length - 8_000));
}

async function stderrTail(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.slice(Math.max(0, raw.length - 8_000));
}

async function waitForTerminalConnectUrlReady(connectUrl: string, timeoutMs = 60_000): Promise<string> {
  const connectUrlCandidates = expandLoopbackBaseUrlCandidates(connectUrl);
  let readyUrl = connectUrl;
  await waitFor(
    async () => {
      for (const candidateUrl of connectUrlCandidates) {
        try {
          const res = await fetch(candidateUrl, { signal: AbortSignal.timeout(2_000) });
          if (res.ok) {
            readyUrl = candidateUrl;
            return true;
          }
        } catch {
          // Try the next loopback-equivalent candidate.
        }
      }
      return false;
    },
    {
      timeoutMs,
      intervalMs: 250,
      context: 'terminal connect URL readiness',
    },
  );
  return readyUrl;
}

function resolveTerminalConnectReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.HAPPIER_E2E_CLI_TERMINAL_CONNECT_READY_TIMEOUT_MS ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

async function waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
    return { code: proc.child.exitCode, signal: proc.child.signalCode as NodeJS.Signals | null };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for CLI process to exit after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });
}

export type StartedCliTerminalConnect = {
  connectUrl: string;
  proc: SpawnedProcess;
  waitForSuccess: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startCliAuthLoginForTerminalConnect(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  waitForConnectUrlReady?: boolean;
  env: NodeJS.ProcessEnv;
}>): Promise<StartedCliTerminalConnect> {
  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await sweepProcessOwnershipLeases({
      rootDir: repoRootDir(),
      leaseKind: 'cli-terminal-connect',
      currentOwnerPid: process.pid,
      currentOwnerStartTime: currentOwnerInspection.startTime,
      isOwnedProcessCommand: (command) => looksLikeCliTerminalConnectCommand(command),
    });
  }

  const cliLaunchSpec = await resolveCliTestLaunchSpec(
    { testDir: params.testDir, env: params.env },
    { snapshotDir: resolvePath(params.testDir, 'cli-dist') },
  );

  const stdoutPath = resolvePath(params.testDir, 'cli.auth.login.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'cli.auth.login.stderr.log');

  const proc = spawnLoggedProcess({
    command: cliLaunchSpec.command,
    args: [...cliLaunchSpec.args, 'auth', 'login', '--force', '--no-open', '--method', 'web'],
    cwd: repoRootDir(),
    env: {
      ...params.env,
      ...(cliLaunchSpec.env ?? {}),
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
    },
    stdoutPath,
    stderrPath,
  });

  await registerProcessOwnershipLease({
    rootDir: repoRootDir(),
    leaseKind: 'cli-terminal-connect',
    child: proc.child,
    ownerPid: process.pid,
    ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
    metadata: {
      cliHomeDir: params.cliHomeDir,
      serverUrl: params.serverUrl,
      webappUrl: params.webappUrl,
    },
  });

  let connectUrl: string | null = null;
  try {
    const match = await waitForRegexInFile({
      path: stdoutPath,
      regex: /https?:\/\/[^\s)]+\/terminal\/connect#key=[^\s]+/,
      timeoutMs: 180_000,
      pollMs: 100,
      context: 'CLI terminal connect URL',
    });
    connectUrl = extractTerminalConnectUrl(match.input ?? '') ?? normalizeUrl(match[0] ?? '');
  } catch (e) {
    const tail = await stdoutTail(stdoutPath);
    await proc.stop().catch(() => {});
    throw new Error(`${String(e)} | stdoutTail=${JSON.stringify(tail)}`);
  }

  if (!connectUrl) {
    const tail = await stdoutTail(stdoutPath);
    await proc.stop().catch(() => {});
    throw new Error(`Failed to extract terminal connect URL from CLI stdout | stdoutTail=${JSON.stringify(tail)}`);
  }

  if (params.waitForConnectUrlReady !== false) {
    connectUrl = await waitForTerminalConnectUrlReady(connectUrl, resolveTerminalConnectReadyTimeoutMs(params.env));
  }

  return {
    connectUrl,
    proc,
    waitForSuccess: async () => {
      const { code, signal } = await waitForExit(proc, 120_000);
      if (code === 0) return;
      const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      const outTail = await stdoutTail(stdoutPath);
      const errTail = await stderrTail(stderrPath);
      throw new Error(
        [
          `CLI auth login exited with ${detail}`,
          `stdoutTail=${JSON.stringify(outTail)}`,
          `stderrTail=${JSON.stringify(errTail)}`,
        ].join(' | '),
      );
    },
    stop: async () => {
      await proc.stop().catch(() => {});
    },
  };
}
