import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { saveCursorSubscriptionCredential } from './subscription.js';

export type CursorNativeCredential = Readonly<{ accessToken: string; refreshToken: string }>;
type KeyringInput = Readonly<{ service: string; account: string; signal?: AbortSignal }>;
type NativeReadOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  readKeyring?: (input: KeyringInput) => Promise<string | null>;
}>;

export class CursorNativeImportError extends Error {
  readonly code: 'credentials_unavailable' | 'schema_unsupported';
  constructor(code: CursorNativeImportError['code']) {
    super(code === 'credentials_unavailable' ? 'Cursor native credentials are unavailable' : 'Unsupported Cursor native auth store');
    this.name = 'CursorNativeImportError';
    this.code = code;
  }
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Cursor credential import cancelled', 'AbortError');
}

const execFileAsync = promisify(execFile);
async function readCursorKeyring(input: KeyringInput): Promise<string | null> {
  assertNotCancelled(input.signal);
  try {
    const { stdout } = await execFileAsync('/usr/bin/security',
      ['find-generic-password', '-s', input.service, '-a', input.account, '-w'],
      { encoding: 'utf8', signal: input.signal });
    return stdout.trim() || null;
  } catch (error) {
    assertNotCancelled(input.signal);
    // Keychain diagnostics can contain private values; retain only the typed outcome.
    if (error && typeof error === 'object' && 'code' in error && error.code === 44) return null;
    throw new CursorNativeImportError('credentials_unavailable');
  }
}

function parseNativeCredential(value: unknown): CursorNativeCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CursorNativeImportError('schema_unsupported');
  const record = value as Record<string, unknown>;
  const accessToken = typeof record.accessToken === 'string' ? record.accessToken.trim() : '';
  const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken.trim() : '';
  if (!accessToken || !refreshToken || (typeof record.apiKey === 'string' && record.apiKey.trim())) {
    throw new CursorNativeImportError('schema_unsupported');
  }
  return { accessToken, refreshToken };
}

/** Read-only selected Machine import. Cursor CLI 2026.11.05-86047df cli-credentials
 * owns this layout: macOS Keychain by default; auth.json for Windows/Linux and
 * AGENT_CLI_CREDENTIAL_STORE=file on macOS. cli-config.json holds settings only. */
export async function readCursorNativeCredential(options: NativeReadOptions = {}): Promise<CursorNativeCredential> {
  const { signal } = options;
  assertNotCancelled(signal);
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const store = environment.AGENT_CLI_CREDENTIAL_STORE;
  if (store === 'memory') throw new CursorNativeImportError('credentials_unavailable');
  if (platform === 'darwin' && store !== 'file') {
    const read = options.readKeyring ?? readCursorKeyring;
    try {
      const [accessToken, refreshToken, apiKey] = await Promise.all([
        read({ service: 'cursor-access-token', account: 'cursor-user', signal }),
        read({ service: 'cursor-refresh-token', account: 'cursor-user', signal }),
        read({ service: 'cursor-api-key', account: 'cursor-user', signal }),
      ]);
      assertNotCancelled(signal);
      if (!accessToken || !refreshToken) throw new CursorNativeImportError('credentials_unavailable');
      return parseNativeCredential({ accessToken, refreshToken, apiKey });
    } catch (error) {
      assertNotCancelled(signal);
      if (error instanceof CursorNativeImportError) throw error;
      throw new CursorNativeImportError('credentials_unavailable');
    }
  }
  const home = resolveHomeDirFromEnvironment(environment, platform);
  const directory = platform === 'win32'
    ? join(environment.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor')
    : platform === 'darwin' ? join(home, '.cursor')
      : join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'cursor');
  let contents: string;
  try {
    contents = await readFile(join(directory, 'auth.json'), { encoding: 'utf8', signal });
  } catch {
    assertNotCancelled(signal);
    throw new CursorNativeImportError('credentials_unavailable');
  }
  assertNotCancelled(signal);
  let parsed: unknown;
  try { parsed = JSON.parse(contents); }
  catch { throw new CursorNativeImportError('schema_unsupported'); }
  return parseNativeCredential(parsed);
}

type CursorNativeImportMode = Extract<ConnectedAccountRuntime['authentication']['modes'][string], { kind: 'manual' }>;

/** Only the daemon composes this mode; portable Account artifacts do not read local credentials. */
export function createCursorNativeImportMode(): CursorNativeImportMode {
  return {
    kind: 'manual',
    async complete(input, context, options) {
      if (input.fields.source !== 'native') return { status: 'rejected', diagnostic: {
        code: 'cursor_native_source_unsupported', severity: 'error', message: 'Choose the native Cursor login import source.',
      } };
      const signal = options?.signal ?? context.signal;
      let credentials: CursorNativeCredential;
      try { credentials = await readCursorNativeCredential({ signal }); }
      catch (error) {
        assertNotCancelled(signal);
        if (error instanceof CursorNativeImportError && error.code === 'schema_unsupported') return { status: 'rejected', diagnostic: {
          code: 'cursor_native_schema_unsupported', severity: 'error', message: 'Sign in with cursor-agent login on the selected Machine before importing.',
        } };
        return { status: 'unavailable', diagnostic: {
          code: 'cursor_native_credentials_unavailable', severity: 'error', message: 'Cursor native credentials are unavailable on the selected Machine. Run cursor-agent login there and retry.',
        } };
      }
      return saveCursorSubscriptionCredential(credentials, context, { signal });
    },
  };
}
