import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

export const HAPPIER_OPENCODE_SERVER_URL_ENV_KEY = 'HAPPIER_OPENCODE_SERVER_URL';
export const OPENCODE_SERVER_PASSWORD_ENV_KEY = 'OPENCODE_SERVER_PASSWORD';

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
