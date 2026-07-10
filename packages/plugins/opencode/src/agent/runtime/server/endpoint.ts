import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';

export const HAPPIER_OPENCODE_SERVER_URL_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_URL';
export const OPENCODE_SERVER_PASSWORD_ENV_KEY = 'OPENCODE_SERVER_PASSWORD';

export type OpenCodeServerCredential = Readonly<{
  envKey: typeof OPENCODE_SERVER_PASSWORD_ENV_KEY;
  value: string;
  headers: Readonly<Record<string, string>>;
}>;

type RegisteredOpenCodeManagedServerCredential = Readonly<{
  headers: Readonly<Record<string, string>>;
}>;

export type OpenCodeServerEndpoint =
  | Readonly<{
    mode: 'external-attach';
    baseUrl: string;
    credential: null;
  }>
  | Readonly<{
    mode: 'managed-spawn';
  }>;

export function readOpenCodeSessionEnvironment(params: unknown): Readonly<Record<string, string>> {
  const record = asRecord(params);
  return Object.fromEntries(
    Object.entries(readStringRecord(asRecord(record?.isolation)?.env ?? record?.env))
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export function readOpenCodeServerEndpoint(
  ctx: PluginContextV1,
  params: unknown,
): OpenCodeServerEndpoint {
  const env = readOpenCodeSessionEnvironment(params);
  const explicitBaseUrl = normalizeString(env[HAPPIER_OPENCODE_SERVER_URL_ENV_KEY])
    || normalizeString(ctx.config?.values?.[HAPPIER_OPENCODE_SERVER_URL_ENV_KEY]);
  if (explicitBaseUrl) {
    return {
      mode: 'external-attach',
      baseUrl: explicitBaseUrl.replace(/\/+$/u, ''),
      credential: null,
    };
  }
  return { mode: 'managed-spawn' };
}

export function createOpenCodeManagedServerCredential(): OpenCodeServerCredential {
  const value = randomBytes(24).toString('hex');
  return {
    envKey: OPENCODE_SERVER_PASSWORD_ENV_KEY,
    value,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${value}`, 'utf8').toString('base64')}`,
    },
  };
}

const managedServerCredentialsByBaseUrl = new Map<string, RegisteredOpenCodeManagedServerCredential>();

function normalizeOpenCodeServerBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function registerOpenCodeManagedServerCredential(params: Readonly<{
  baseUrl: string;
  credential: OpenCodeServerCredential;
}>): Readonly<{ dispose: () => void }> {
  const key = normalizeOpenCodeServerBaseUrl(params.baseUrl);
  const entry: RegisteredOpenCodeManagedServerCredential = {
    headers: params.credential.headers,
  };
  managedServerCredentialsByBaseUrl.set(key, entry);
  return {
    dispose: () => {
      if (managedServerCredentialsByBaseUrl.get(key) === entry) {
        managedServerCredentialsByBaseUrl.delete(key);
      }
    },
  };
}

export function readOpenCodeManagedServerCredentialHeaders(
  baseUrl: string,
): Readonly<Record<string, string>> | null {
  return managedServerCredentialsByBaseUrl.get(normalizeOpenCodeServerBaseUrl(baseUrl))?.headers ?? null;
}
