import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { OpenCodeServerTransport } from './transport.js';

export const HAPPIER_OPENCODE_SERVER_URL_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_URL';
export const OPENCODE_SERVER_PASSWORD_ENV_KEY = 'OPENCODE_SERVER_PASSWORD';

export type OpenCodeServerCredential = Readonly<{
  envKey: typeof OPENCODE_SERVER_PASSWORD_ENV_KEY;
  value: string;
  headers: Readonly<Record<string, string>>;
}>;

type RegisteredOpenCodeManagedServerEndpoint = Readonly<{
  generationToken: string;
  transport: OpenCodeServerTransport;
  credential: Readonly<{
    headers: Readonly<Record<string, string>>;
  }> | null;
}>;

export type OpenCodeManagedServerEndpointRegistration = Readonly<{
  baseUrl: string;
  generationToken: string;
  transport: OpenCodeServerTransport;
  headers?: Readonly<Record<string, string>>;
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
  ctx: OpenCodeRuntimeContext,
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

const managedServerEndpointsByBaseUrl = new Map<
  string,
  RegisteredOpenCodeManagedServerEndpoint[]
>();
let managedServerEndpointGeneration = 0;

function normalizeOpenCodeServerBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

export function registerOpenCodeManagedServerEndpoint(params: Readonly<{
  baseUrl: string;
  credential: OpenCodeServerCredential | null;
  transport: OpenCodeServerTransport;
}>): Readonly<{ dispose: () => void }> {
  const key = normalizeOpenCodeServerBaseUrl(params.baseUrl);
  const entry: RegisteredOpenCodeManagedServerEndpoint = {
    generationToken: `managed-endpoint-${(++managedServerEndpointGeneration).toString(36)}`,
    transport: params.transport,
    credential: params.credential
      ? {
        headers: params.credential.headers,
      }
      : null,
  };
  const registrations = managedServerEndpointsByBaseUrl.get(key) ?? [];
  managedServerEndpointsByBaseUrl.set(key, [...registrations, entry]);
  return {
    dispose: () => {
      const current = managedServerEndpointsByBaseUrl.get(key);
      if (!current) return;
      const remaining = current.filter((registration) => registration !== entry);
      if (remaining.length === 0) {
        managedServerEndpointsByBaseUrl.delete(key);
      } else if (remaining.length !== current.length) {
        managedServerEndpointsByBaseUrl.set(key, remaining);
      }
    },
  };
}

export function readOpenCodeManagedServerEndpointRegistration(
  baseUrl: string,
): OpenCodeManagedServerEndpointRegistration | null {
  const normalizedBaseUrl = normalizeOpenCodeServerBaseUrl(baseUrl);
  const registrations = managedServerEndpointsByBaseUrl.get(normalizedBaseUrl);
  const registration = registrations?.[registrations.length - 1];
  if (!registration) return null;
  return {
    baseUrl: normalizedBaseUrl,
    generationToken: registration.generationToken,
    transport: registration.transport,
    ...(registration.credential
      ? { headers: registration.credential.headers }
      : {}),
  };
}

export function readOpenCodeManagedServerEndpointRegistrationByGenerationToken(
  generationToken: string,
): OpenCodeManagedServerEndpointRegistration | null {
  for (const [baseUrl, endpoints] of managedServerEndpointsByBaseUrl) {
    for (const endpoint of endpoints) {
      if (endpoint.generationToken === generationToken) {
        return {
          baseUrl,
          generationToken: endpoint.generationToken,
          transport: endpoint.transport,
          ...(endpoint.credential
            ? { headers: endpoint.credential.headers }
            : {}),
        };
      }
    }
  }
  return null;
}

export function readOpenCodeManagedServerTransport(
  baseUrl: string,
): OpenCodeServerTransport | null {
  return readOpenCodeManagedServerEndpointRegistration(baseUrl)?.transport ?? null;
}
