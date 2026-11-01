import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

const AGY_OAUTH_CLIENT_ID = ANTIGRAVITY_OAUTH_PROFILE.clientId;
const AGY_OAUTH_TOKEN_URL = ANTIGRAVITY_OAUTH_PROFILE.tokenUrl;
type NativeReadWarning = (message: string) => void;

// This trusted daemon adapter reads native OS credentials only after explicit native-import
// authentication on the chosen machine. Workspace filesystem grants do not authorize this
// boundary. macOS preserves Keychain consent; Linux follows native Secret Service selection;
// Windows exposes the fixed CLI file only because its automatic keyring is uncharacterized.

export type AgyNativeCredential = Readonly<{
  accessToken: string | null;
  refreshToken: string;
  expiresAt: number | null;
  projectId: string | null;
}>;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const unavailable = () => Object.assign(new Error('Antigravity native credentials are unavailable'), { code: 'credentials_unavailable' });

/** ACP 1.3.0 credential_store.py and CLI 1.3.3 consumer token envelope. File scopes are requested scopes, never grant evidence. */
export function parseAgyNativeCredential(value: unknown, source: 'acp' | 'cli'): AgyNativeCredential | null {
  const data = record(value);
  if (!data) return null;
  if (source === 'acp' && (text(data.client_id) !== AGY_OAUTH_CLIENT_ID || (text(data.token_uri) && text(data.token_uri) !== AGY_OAUTH_TOKEN_URL))) return null;
  if (source === 'cli' && data.auth_method !== 'consumer') return null;
  const tokens = source === 'cli' ? record(data.token) : data;
  const refreshToken = text(tokens?.refresh_token);
  if (!tokens || !refreshToken) return null;
  const expiry = text(tokens.expiry);
  const expiresAt = expiry ? Date.parse(expiry) : typeof tokens.expiry_date === 'number' ? tokens.expiry_date : null;
  const accessToken = source === 'acp' ? text(tokens.token) ?? text(tokens.access_token) : text(tokens.access_token);
  return { accessToken, refreshToken, expiresAt: expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt : null, projectId: text(data.project_id) };
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

async function readKeyring(account: string, signal?: AbortSignal): Promise<string | null> {
  const darwin = process.platform === 'darwin';
  const args = darwin ? ['find-generic-password', '-s', 'gemini', '-a', account, '-w'] : ['lookup', 'service', 'gemini', 'username', account];
  const result = await readCredentialCommand(darwin ? '/usr/bin/security' : 'secret-tool', args, signal, account === 'antigravity' ? CLI_KEYRING_BUDGET_MS : undefined);
  if (result.status === 0) return result.contents || null;
  if (darwin && result.status === 44) return null;
  throw unavailable();
}

async function nativeCliBypassesKeyring(warn: NativeReadWarning, signal?: AbortSignal): Promise<boolean> {
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
        warn('[Antigravity import] Native storage detector budget expired; trying Keyring');
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

async function nativeCliUsesFile(directory: string, warn: NativeReadWarning, signal?: AbortSignal): Promise<boolean> {
  if (await nativeCliBypassesKeyring(warn, signal)) return true;
  try {
    const marker = await stat(join(directory, 'cache', 'antigravity-keyring-unavailable'));
    return Date.now() - marker.mtimeMs < CLI_KEYRING_MARKER_AGE_MS;
  } catch (error) {
    signal?.throwIfAborted();
    if (record(error)?.code !== 'ENOENT') warn('[Antigravity import] Could not inspect native Keyring timeout marker; trying Keyring');
    return false;
  }
}

export async function readAgyNativeCredential(source: 'acp' | 'cli' | 'cli-file', warn: NativeReadWarning, signal?: AbortSignal): Promise<AgyNativeCredential> {
  signal?.throwIfAborted();
  // Windows credential-manager selection/reading has not been characterized.
  // Do not silently import a stale file instead of the native selected login.
  if (source === 'cli' && process.platform !== 'linux' && process.platform !== 'darwin') throw unavailable();
  const home = resolveHomeDirFromEnvironment(process.env);
  const geminiHome = process.env.GEMINI_HOME ? expandHomePath(process.env.GEMINI_HOME, home) : join(home, '.gemini');
  const cliDirectory = join(home, '.gemini', 'antigravity-cli');
  const file = source === 'acp' ? join(geminiHome, 'antigravity-acp', 'acp_token.json') : join(cliDirectory, 'antigravity-oauth-token');
  let contents: string | null = null;
  const forceAcpFile = ['1', 'true', 'yes'].includes((process.env.AGY_ACP_FORCE_FILE_STORAGE ?? '').toLowerCase());
  if (source === 'acp' && process.platform === 'darwin' && !forceAcpFile) {
    // ACP 1.3.0 checks the default Keychain with this read-only command and 2 s budget.
    const keychain = await readCredentialCommand('/usr/bin/security', ['default-keychain'], signal, 2_000);
    if (keychain.status === 0 && keychain.contents.replace(/^"|"$/g, '')) {
      // Replaying ACP's writable functional probe would change native storage.
      // A missing/failed Keychain read cannot establish that native ACP selected file.
      contents = await readKeyring('antigravity-acp', signal);
      if (!contents) throw unavailable();
    }
  } else if (source === 'cli' && !await nativeCliUsesFile(cliDirectory, warn, signal)) {
    try {
      contents = await readKeyring('antigravity', signal);
      if (contents) {
        const value: unknown = JSON.parse(contents);
        // Both native token-object decoders reject non-null primitives/arrays.
        if (value !== null && !record(value)) throw unavailable();
      }
    } catch {
      signal?.throwIfAborted();
      warn('[Antigravity import] Native Keyring read failed; trying native file storage');
      contents = null;
    }
  }
  if (!contents) {
    try { contents = await readFile(file, { encoding: 'utf8', signal }); }
    catch { signal?.throwIfAborted(); throw unavailable(); }
  }
  try { const credential = parseAgyNativeCredential(JSON.parse(contents), source === 'acp' ? 'acp' : 'cli'); if (credential) return credential; }
  catch { /* Safe typed boundary failure below. */ }
  throw unavailable();
}
