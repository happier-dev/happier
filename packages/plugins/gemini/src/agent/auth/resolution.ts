import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';

export const GEMINI_ACP_AUTH_METHOD_ENV = 'HAPPIER_GEMINI_ACP_AUTH_METHOD';
export const GEMINI_ACP_AUTH_META_ENV = 'HAPPIER_GEMINI_ACP_AUTH_META';
export const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';
export const GOOGLE_API_KEY_ENV = 'GOOGLE_API_KEY';
export const GOOGLE_GENAI_USE_VERTEXAI_ENV = 'GOOGLE_GENAI_USE_VERTEXAI';
export const GOOGLE_CLOUD_PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT';
export const GOOGLE_CLOUD_LOCATION_ENV = 'GOOGLE_CLOUD_LOCATION';

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export type GeminiAuthConfig = {
  mode: 'api-key' | 'vertex';
  authMethodId: string;
  shouldInjectApiKeyEnv: boolean;
  shouldUseIsolatedMcpHome: boolean;
  launchEnv?: Readonly<Record<string, string>>;
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

export function hasGeminiAcpCredentialEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  if (resolveGeminiApiKeyFromEnv(env)) return true;
  return isTruthyEnv(env[GOOGLE_GENAI_USE_VERTEXAI_ENV])
    && readNonEmptyEnv(env, GOOGLE_CLOUD_PROJECT_ENV) !== null
    && readNonEmptyEnv(env, GOOGLE_CLOUD_LOCATION_ENV) !== null;
}

function hasIncompleteVertexEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  if (!isTruthyEnv(env[GOOGLE_GENAI_USE_VERTEXAI_ENV])) return false;
  return readNonEmptyEnv(env, GOOGLE_CLOUD_PROJECT_ENV) === null
    || readNonEmptyEnv(env, GOOGLE_CLOUD_LOCATION_ENV) === null;
}

export function assertCompleteGeminiVertexEnv(env: Readonly<Record<string, string | undefined>>): void {
  if (!hasIncompleteVertexEnv(env)) return;
  throw new Error(
    'Gemini Vertex ACP auth requires GOOGLE_GENAI_USE_VERTEXAI with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.',
  );
}

function createMissingGeminiAcpCredentialError(): Error {
  return new Error(
    'Gemini ACP auth requires GEMINI_API_KEY, GOOGLE_API_KEY, or complete Vertex env with GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_CLOUD_PROJECT, and GOOGLE_CLOUD_LOCATION.',
  );
}

export function resolveGeminiAuthConfig(env: Readonly<Record<string, string | undefined>>, apiKey: string | null): GeminiAuthConfig {
  const configuredMethod = env[GEMINI_ACP_AUTH_METHOD_ENV]?.trim();
  if (configuredMethod === 'vertex-ai') {
    assertCompleteGeminiVertexEnv({
      ...env,
      [GOOGLE_GENAI_USE_VERTEXAI_ENV]: '1',
    });
    return {
      mode: 'vertex',
      authMethodId: 'vertex-ai',
      shouldInjectApiKeyEnv: false,
      shouldUseIsolatedMcpHome: true,
      launchEnv: {
        [GOOGLE_GENAI_USE_VERTEXAI_ENV]: '1',
      },
    };
  }
  assertCompleteGeminiVertexEnv(env);
  if (isTruthyEnv(env[GOOGLE_GENAI_USE_VERTEXAI_ENV])) {
    return {
      mode: 'vertex',
      authMethodId: 'vertex-ai',
      shouldInjectApiKeyEnv: false,
      shouldUseIsolatedMcpHome: true,
      launchEnv: {
        [GOOGLE_GENAI_USE_VERTEXAI_ENV]: '1',
      },
    };
  }
  if (apiKey) {
    return {
      mode: 'api-key',
      authMethodId: 'gemini-api-key',
      shouldInjectApiKeyEnv: true,
      shouldUseIsolatedMcpHome: true,
    };
  }
  throw createMissingGeminiAcpCredentialError();
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

export async function resolveGeminiAcpFlag(exec: Pick<PluginExecService, 'run'>, params: {
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<GeminiAcpFlag> {
  if (params.signal?.aborted) {
    throw createAbortError();
  }
  try {
    const result = await exec.run({
      executable: { kind: 'systemTool', id: 'gemini-cli' },
      args: ['--help'],
      env: params.env,
      timeoutMs: 2000,
    }, {
      signal: params.signal,
    });

    if (params.signal?.aborted) {
      throw createAbortError();
    }

    const decoder = new TextDecoder();
    const output = `${decoder.decode(result.stdout)}\n${decoder.decode(result.stderr)}`;
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
