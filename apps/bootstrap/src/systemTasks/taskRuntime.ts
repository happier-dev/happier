import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import {
  normalizePublicReleaseRingLabel,
  resolvePublicReleaseRingIdForLabel,
  type PublicReleaseRingLabel,
} from '@happier-dev/release-runtime/releaseRings';

export interface CommandExecutionResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function normalizeBootstrapChannel(raw: unknown): Readonly<{
  commandChannel: 'stable' | 'preview' | 'dev';
  releaseChannel: 'stable' | 'preview' | 'publicdev';
}> {
  const label = normalizePublicReleaseRingLabel(raw);
  const commandChannel: PublicReleaseRingLabel = label || 'stable';
  const releaseChannel = resolvePublicReleaseRingIdForLabel(commandChannel);
  return { commandChannel, releaseChannel };
}

export async function runCommandCapture(params: Readonly<{
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number | null;
  stdinText?: string;
  signal?: AbortSignal;
}>): Promise<CommandExecutionResult> {
  params.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    // An npm `happier.cmd` shim (a CLI the person kept, R12) cannot be spawned directly on Windows;
    // the process owner routes it through cmd.exe. A no-op off Windows and for real executables.
    const invocation = resolveWindowsCommandInvocation({ command: params.command, args: [...params.args], env: params.env ?? process.env });
    const child = spawn(invocation.command, invocation.args, {
      env: params.env,
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      stdio: [params.stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (params.stdinText !== undefined) {
      child.stdin?.end(params.stdinText);
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const cleanup = (): void => {
      if (timeout !== null) clearTimeout(timeout);
      params.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      cleanup();
      reject(params.signal?.reason instanceof Error ? params.signal.reason : new DOMException('This operation was aborted', 'AbortError'));
    };
    const timeout = params.timeoutMs === null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      cleanup();
      reject(new Error(`Command timed out: ${params.command}`));
    }, Number.isFinite(params.timeoutMs) ? Math.max(1, Math.floor(params.timeoutMs as number)) : 60_000);
    params.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      cleanup();
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

export { resolveDefaultKnownHostsPath } from '@happier-dev/cli-common/ssh';

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
