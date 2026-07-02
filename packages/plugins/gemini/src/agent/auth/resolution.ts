import type { PluginContextV1 } from '@happier-dev/plugin-sdk';

export const GEMINI_ACP_AUTH_METHOD_ENV = 'HAPPIER_GEMINI_ACP_AUTH_METHOD';
export const GEMINI_ACP_AUTH_META_ENV = 'HAPPIER_GEMINI_ACP_AUTH_META';
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseGeminiAuthMeta(value: string | undefined): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type GeminiAuthConfig = {
  authMethodId: string;
  authMeta?: Record<string, unknown>;
  shouldInjectApiKeyEnv: boolean;
};

function readNonEmptyEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveGeminiApiKeyFromEnv(env: Readonly<Record<string, string | undefined>>): string | null {
  return readNonEmptyEnv(env, GEMINI_API_KEY_ENV) ?? readNonEmptyEnv(env, GOOGLE_API_KEY_ENV);
}

export function resolveGeminiAuthConfig(env: Readonly<Record<string, string | undefined>>, apiKey: string | null): GeminiAuthConfig {
  const configuredMethod = env[GEMINI_ACP_AUTH_METHOD_ENV]?.trim();
  const configuredMeta = parseGeminiAuthMeta(env[GEMINI_ACP_AUTH_META_ENV]);
  if (configuredMethod === 'gateway') {
    return {
      authMethodId: 'gateway',
      ...(configuredMeta ? { authMeta: configuredMeta } : {}),
      shouldInjectApiKeyEnv: false,
    };
  }
  if (configuredMethod === 'vertex-ai') {
    return { authMethodId: 'vertex-ai', shouldInjectApiKeyEnv: false };
  }
  if (isTruthyEnv(env.GOOGLE_GENAI_USE_VERTEXAI)) {
    return { authMethodId: 'vertex-ai', shouldInjectApiKeyEnv: false };
  }
  return apiKey
    ? { authMethodId: 'gemini-api-key', shouldInjectApiKeyEnv: true }
    : { authMethodId: 'oauth-personal', shouldInjectApiKeyEnv: false };
}

export type GeminiAcpFlag = '--acp' | '--experimental-acp';

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError';
}

function createAbortError(): Error {
  const error = new Error('Gemini ACP flag probe was aborted.');
  error.name = 'AbortError';
  return error;
}

export async function resolveGeminiAcpFlag(ctx: PluginContextV1, params: {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<GeminiAcpFlag> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  try {
    const result = await ctx.exec.run({
      kind: 'agent-cli',
      agentId: 'gemini',
      args: [...(params.args ?? []), '--help'],
      env: params.env,
    }, {
      timeoutMs: 2000,
      signal: params.signal,
    });

    if (params.signal?.aborted) {
      throw createAbortError();
    }

    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes('--acp')) return '--acp';
    if (output.includes('--experimental-acp')) return '--experimental-acp';
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw error;
    }
    // Fallback if probe fails
  }
  return '--acp';
}
