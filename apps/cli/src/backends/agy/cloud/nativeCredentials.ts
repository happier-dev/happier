import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { ConnectedServiceImportError } from '@/cloud/connectedServices/connectedServiceImportError';
import { resolveAgyMachineProfileDir } from '../acp/agyAcpLaunch';

export type AgyNativeCredential = Readonly<{
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
}>;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unavailable = () => new ConnectedServiceImportError('credentials_unavailable', 'Antigravity native credentials are unavailable');

/** CLI consumer token envelope (`antigravity-oauth-token`). File scopes are requested scopes, never grant evidence. */
export function parseAgyNativeCredential(value: unknown): AgyNativeCredential | null {
  const data = record(value);
  if (!data || data.auth_method !== 'consumer') return null;
  const tokens = record(data.token);
  const refreshToken = text(tokens?.refresh_token);
  if (!tokens || !refreshToken) return null;
  const expiry = text(tokens.expiry);
  const expiresAt = expiry ? Date.parse(expiry) : null;
  return { accessToken: text(tokens.access_token), refreshToken, expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null };
}

/** The Antigravity CLI token file inside a `--gemini-dir` profile. */
export const AGY_NATIVE_TOKEN_FILE_SEGMENTS = ['antigravity-cli', 'antigravity-oauth-token'] as const;

/**
 * Encode a credential as the CLI consumer token envelope that {@link parseAgyNativeCredential} reads.
 * An unknown expiry is written as already expired so the CLI refreshes before its first request.
 */
export function serializeAgyNativeCliCredential(credential: Readonly<{
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
  email: string | null;
}>, now: number = Date.now()): Record<string, unknown> {
  const expiresAt = credential.expiresAt ?? 0;
  return {
    auth_method: 'consumer',
    ...(credential.email ? { id_token_email: credential.email } : {}),
    token: {
      access_token: credential.accessToken ?? '',
      refresh_token: credential.refreshToken,
      token_type: 'Bearer',
      expiry: new Date(expiresAt).toISOString(),
      expires_in: Math.max(0, Math.floor((expiresAt - now) / 1000)),
    },
  };
}

// Native CLI 1.3.3 uses a 500 ms detector budget, a 5 s Keyring read budget,
// and a marker younger than one hour (os.Stat.ModTime, not its contents).
const CLI_DETECTOR_BUDGET_MS = 500;
const CLI_KEYRING_BUDGET_MS = 5_000;
const CLI_KEYRING_MARKER_AGE_MS = 3_600_000;

async function readCredentialCommand(command: string, args: string[], signal?: AbortSignal, timeoutMs?: number): Promise<{ status: number | null; contents: string }> {
  signal?.throwIfAborted();
  // Unit tests must mock this OS boundary, never inspect an ambient native login.
  if (process.env.VITEST && !Object.prototype.hasOwnProperty.call(spawn, 'mock')) throw unavailable();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => { settle(() => reject(new DOMException('Credential import cancelled', 'AbortError'))); child.kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => {
      settle(() => reject(unavailable()));
      child.kill();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    child.stderr?.resume();
    child.once('error', () => settle(() => reject(unavailable())));
    child.once('close', (status) => settle(() => resolve({ status, contents: Buffer.concat(chunks).toString('utf8').trim() })));
    if (signal?.aborted) abort();
  });
}

async function readKeyring(signal?: AbortSignal): Promise<string | null> {
  const darwin = process.platform === 'darwin';
  const args = darwin ? ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'] : ['lookup', 'service', 'gemini', 'username', 'antigravity'];
  const result = await readCredentialCommand(darwin ? '/usr/bin/security' : 'secret-tool', args, signal, CLI_KEYRING_BUDGET_MS);
  if (result.status === 0) return result.contents || null;
  if (darwin && result.status === 44) return null;
  throw unavailable();
}

async function nativeCliBypassesKeyring(signal?: AbortSignal): Promise<boolean> {
  if (['SSH_TTY', 'SSH_CLIENT', 'SSH_CONNECTION', 'WSL_DISTRO_NAME', 'WSL_INTEROP'].some(key => Boolean(process.env[key]))) return true;
  const inspectText = async (file: string, matches: (contents: string) => boolean) => {
    try { return matches(await readFile(file, { encoding: 'utf8', signal })); }
    catch { signal?.throwIfAborted(); return false; }
  };
  const detectors = [
    stat('/.dockerenv').then(() => true, () => false),
    inspectText('/proc/1/cgroup', contents => ['docker', 'containerd', 'kubepods'].some(value => contents.includes(value))),
    inspectText('/proc/sys/kernel/osrelease', contents => ['microsoft', 'wsl'].some(value => contents.toLowerCase().includes(value))),
  ];
  // The darwin 1.3.3 D-Bus detector returns false unconditionally.
  const address = process.env.DBUS_SESSION_BUS_ADDRESS ?? '';
  if (process.platform === 'linux' && ['', 'none:', 'disabled:'].includes(address)) {
    const bus = process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, 'bus') : `/run/user/${process.getuid!()}/bus`;
    detectors.push(stat(bus).then(info => !info.isSocket(), () => true));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.any(detectors.map(async detector => { if (await detector) return true; throw false; })).catch(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => {
        logger.infoFile('[Antigravity import] Native storage detector budget expired; trying Keyring');
        resolve(false);
      }, CLI_DETECTOR_BUDGET_MS); }),
      new Promise<boolean>((_resolve, reject) => {
        abort = () => reject(new DOMException('Credential import cancelled', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

async function nativeCliUsesFile(directory: string, signal?: AbortSignal): Promise<boolean> {
  if (await nativeCliBypassesKeyring(signal)) return true;
  try {
    const marker = await stat(join(directory, 'cache', 'antigravity-keyring-unavailable'));
    return Date.now() - marker.mtimeMs < CLI_KEYRING_MARKER_AGE_MS;
  } catch (error) {
    signal?.throwIfAborted();
    if (record(error)?.code !== 'ENOENT') logger.infoFile('[Antigravity import] Could not inspect native Keyring timeout marker; trying Keyring');
    return false;
  }
}

export async function readAgyNativeCredential(source: 'cli' | 'cli-file', signal?: AbortSignal): Promise<AgyNativeCredential> {
  signal?.throwIfAborted();
  // Windows credential-manager selection/reading has not been characterized.
  // Do not silently import a stale file instead of the native selected login.
  if (source === 'cli' && process.platform !== 'linux' && process.platform !== 'darwin') throw unavailable();
  // The machine login Happier sessions use: the GEMINI_HOME profile, else ~/.gemini.
  const cliDirectory = join(resolveAgyMachineProfileDir(process.env), 'antigravity-cli');
  let contents: string | null = null;
  if (source === 'cli' && !await nativeCliUsesFile(cliDirectory, signal)) {
    try {
      contents = await readKeyring(signal);
      if (contents) {
        const value: unknown = JSON.parse(contents);
        // Both native token-object decoders reject non-null primitives/arrays.
        if (value !== null && !record(value)) throw unavailable();
      }
    } catch {
      signal?.throwIfAborted();
      logger.infoFile('[Antigravity import] Native Keyring read failed; trying native file storage');
      contents = null;
    }
  }
  if (!contents) {
    try { contents = await readFile(join(cliDirectory, 'antigravity-oauth-token'), { encoding: 'utf8', signal }); }
    catch { signal?.throwIfAborted(); throw unavailable(); }
  }
  try { const credential = parseAgyNativeCredential(JSON.parse(contents)); if (credential) return credential; }
  catch { /* Safe typed boundary failure below. */ }
  throw unavailable();
}
