import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { resolveGeminiAcpFlag, resolveGeminiApiKeyFromEnv, resolveGeminiAuthConfig } from './resolution.js';

function createContext(stdout: string): PluginContextV1 {
  return {
    agentRuntime: {
      exec: {
        run: vi.fn(async () => ({
          exitCode: 0,
          signal: null,
          stdout,
          stderr: '',
        })),
      },
    },
  } as unknown as PluginContextV1;
}

describe('resolveGeminiAcpFlag', () => {
  it('probes Gemini ACP flags through the host-mediated agent CLI launch', async () => {
    const ctx = createContext('Usage: gemini --acp');

    await expect(resolveGeminiAcpFlag(ctx, { env: { GEMINI_CLI_HOME: '/tmp/gemini' } })).resolves.toBe('--acp');

    expect(ctx.agentRuntime.exec.run).toHaveBeenCalledWith(
      {
        kind: 'agent-cli',
        agentId: 'gemini',
        args: ['--help'],
        env: { GEMINI_CLI_HOME: '/tmp/gemini' },
      },
      { timeoutMs: 2000 },
    );
  });

  it('does not convert host-aborted probes into the default flag', async () => {
    const abortError = new Error('Plugin exec operation was aborted');
    abortError.name = 'AbortError';
    const ctx = {
      agentRuntime: {
        exec: {
          run: vi.fn(async () => {
            throw abortError;
          }),
        },
      },
    } as unknown as PluginContextV1;

    await expect(resolveGeminiAcpFlag(ctx, {})).rejects.toBe(abortError);
  });
});

describe('resolveGeminiAuthConfig', () => {
  it('fails closed when no API-key or complete Vertex environment is materialized', () => {
    expect(() => resolveGeminiAuthConfig({}, null)).toThrow(/GEMINI_API_KEY|GOOGLE_API_KEY|Vertex/);
  });

  it('selects API-key auth and isolated Gemini home shaping when an API key is materialized', () => {
    const env = { GOOGLE_API_KEY: 'google-api-key' };

    expect(resolveGeminiAuthConfig(env, resolveGeminiApiKeyFromEnv(env))).toEqual({
      mode: 'api-key',
      authMethodId: 'gemini-api-key',
      shouldInjectApiKeyEnv: true,
      shouldUseIsolatedMcpHome: true,
    });
  });

  it('selects Vertex auth only when project and location are complete', () => {
    expect(resolveGeminiAuthConfig({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    }, null)).toEqual({
      mode: 'vertex',
      authMethodId: 'vertex-ai',
      shouldInjectApiKeyEnv: false,
      shouldUseIsolatedMcpHome: true,
      launchEnv: {
        GOOGLE_GENAI_USE_VERTEXAI: '1',
      },
    });

    expect(() => resolveGeminiAuthConfig({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
    }, null)).toThrow(/GOOGLE_CLOUD_LOCATION/);

    expect(() => resolveGeminiAuthConfig({
      HAPPIER_GEMINI_ACP_AUTH_METHOD: 'vertex-ai',
      GOOGLE_GENAI_USE_VERTEXAI: 'false',
      GOOGLE_CLOUD_PROJECT: 'vertex-project',
    }, null)).toThrow(/GOOGLE_CLOUD_LOCATION/);
  });
});
