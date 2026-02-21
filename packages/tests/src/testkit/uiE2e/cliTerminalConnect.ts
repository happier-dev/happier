import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { ensureCliDistBuilt } from '../process/cliDist';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { repoRootDir } from '../paths';
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
  env: NodeJS.ProcessEnv;
}>): Promise<StartedCliTerminalConnect> {
  const cliDistEntrypoint = await ensureCliDistBuilt({ testDir: params.testDir, env: params.env });

  const stdoutPath = resolvePath(params.testDir, 'cli.auth.login.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'cli.auth.login.stderr.log');

  const proc = spawnLoggedProcess({
    command: process.execPath,
    args: [cliDistEntrypoint, 'auth', 'login', '--force', '--no-open', '--method', 'web'],
    cwd: repoRootDir(),
    env: {
      ...params.env,
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
    },
    stdoutPath,
    stderrPath,
  });

  let connectUrl: string | null = null;
  try {
    const match = await waitForRegexInFile({
      path: stdoutPath,
      regex: /https?:\/\/[^\s)]+\/terminal\/connect#key=[^\s]+/,
      timeoutMs: 90_000,
      pollMs: 100,
      context: 'CLI terminal connect URL',
    });
    connectUrl = extractTerminalConnectUrl(match.input ?? '') ?? normalizeUrl(match[0] ?? '');
  } catch (e) {
    await proc.stop().catch(() => {});
    throw e;
  }

  if (!connectUrl) {
    const tail = await stdoutTail(stdoutPath);
    await proc.stop().catch(() => {});
    throw new Error(`Failed to extract terminal connect URL from CLI stdout | stdoutTail=${JSON.stringify(tail)}`);
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
