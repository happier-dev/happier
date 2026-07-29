import type { PluginExecService } from '@happier-dev/plugin-sdk/runtime';
import { describe, expect, it, vi } from 'vitest';

import { resolveGeminiAcpFlag, resolveGeminiApiKeyFromEnv, resolveGeminiAuthConfig } from './resolution.js';

function createExec(stdout: string): Pick<PluginExecService, 'run'> {
  return {
    run: vi.fn(async () => ({
      termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
      stdout: new TextEncoder().encode(stdout),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    })),
  };
}

describe('resolveGeminiAcpFlag', () => {
  it('probes Gemini ACP flags through the public system-tool exec service', async () => {
    const exec = createExec('Usage: gemini --acp');

    await expect(resolveGeminiAcpFlag(exec, { env: { GEMINI_CLI_HOME: '/tmp/gemini' } })).resolves.toBe('--acp');

    expect(exec.run).toHaveBeenCalledWith(
      {
        executable: { kind: 'systemTool', id: 'gemini-cli' },
        args: ['--help'],
        env: { GEMINI_CLI_HOME: '/tmp/gemini' },
        timeoutMs: 2000,
      },
      { signal: undefined },
    );
  });

  it('does not convert host-aborted probes into the default flag', async () => {
    const abortError = new Error('Plugin exec operation was aborted');
    abortError.name = 'AbortError';
    const exec = { run: vi.fn(async () => { throw abortError; }) };

    await expect(resolveGeminiAcpFlag(exec, {})).rejects.toBe(abortError);
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
