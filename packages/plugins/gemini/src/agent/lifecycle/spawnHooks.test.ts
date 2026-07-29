import { describe, expect, it } from 'vitest';

import { resolveGeminiDaemonSpawnPrerequisites } from './spawnHooks.js';

describe('Gemini daemon spawn prerequisites', () => {
  it('denies daemon spawn before ACP launch when API-key and Vertex credentials are missing', async () => {
    await expect(resolveGeminiDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          env: {},
        },
      },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'gemini_acp_credentials_unavailable',
      errorMessage: expect.stringContaining('GEMINI_API_KEY'),
    });
  });

  it('allows daemon spawn when an API-key credential is materialized', async () => {
    await expect(resolveGeminiDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          env: {
            GEMINI_API_KEY: 'AIzaPluginScopedKey',
          },
        },
      },
    })).resolves.toEqual({ decision: 'allow' });
  });

  it('allows daemon spawn when complete Vertex credentials are materialized', async () => {
    await expect(resolveGeminiDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          env: {
            GOOGLE_GENAI_USE_VERTEXAI: '1',
            GOOGLE_CLOUD_PROJECT: 'test-project',
            GOOGLE_CLOUD_LOCATION: 'us-central1',
          },
        },
      },
    })).resolves.toEqual({ decision: 'allow' });
  });

  it('denies daemon spawn with a Vertex-specific diagnostic when Vertex env is incomplete', async () => {
    await expect(resolveGeminiDaemonSpawnPrerequisites({
      payload: {
        runtimeSelection: {
          env: {
            GOOGLE_GENAI_USE_VERTEXAI: '1',
          },
        },
      },
    })).resolves.toMatchObject({
      decision: 'deny',
      reasonCode: 'gemini_acp_credentials_unavailable',
      errorMessage: expect.stringContaining('GOOGLE_CLOUD_PROJECT'),
    });
  });
});
