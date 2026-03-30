import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export interface CommandExecutionResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function normalizeBootstrapChannel(raw: unknown): Readonly<{
  commandChannel: 'stable' | 'preview' | 'dev';
  releaseChannel: 'stable' | 'preview' | 'publicdev';
}> {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'preview') {
    return { commandChannel: 'preview', releaseChannel: 'preview' };
  }
  if (text === 'dev' || text === 'publicdev') {
    return { commandChannel: 'dev', releaseChannel: 'publicdev' };
  }
  return { commandChannel: 'stable', releaseChannel: 'stable' };
}

export async function runCommandCapture(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}>): Promise<CommandExecutionResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, [...params.args], {
      env: params.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`Command timed out: ${params.command}`));
    }, Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs as number)) : 60_000);

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        status: typeof status === 'number' ? status : 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

export function parseFirstJsonObject(text: string): unknown {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

export function resolveDefaultKnownHostsPath(): string {
  return `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.happier/ssh/known_hosts`;
}

export function extractSshHost(target: string): string {
  const trimmed = String(target ?? '').trim();
  const atIndex = trimmed.lastIndexOf('@');
  return atIndex >= 0 ? trimmed.slice(atIndex + 1) : trimmed;
}

export function computeSshFingerprintFromKnownHostsLine(line: string): string {
  const parts = String(line ?? '').trim().split(/\s+/);
  const encoded = parts[2] ?? '';
  const digest = createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/g, '');
  return `SHA256:${digest}`;
}

export async function ensureKnownHostsEntry(params: Readonly<{
  path: string;
  hostKeyLine: string;
}>): Promise<void> {
  const path = String(params.path ?? '').trim();
  const hostKeyLine = String(params.hostKeyLine ?? '').trim();
  if (!path || !hostKeyLine) return;
  const existing = await readFile(path, 'utf8').catch(() => '');
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(hostKeyLine)) {
    return;
  }

  const slashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (slashIndex > 0) {
    await mkdir(path.slice(0, slashIndex), { recursive: true });
  }
  await writeFile(path, `${[...lines, hostKeyLine, ''].join('\n')}`, 'utf8');
}
