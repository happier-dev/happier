import { describe, expect, it, vi } from 'vitest';

import { createXaiRealtimeVoiceUiClient } from './client.js';

describe('xAI Realtime client', () => {
  it('fetches the provider catalog through bounded account operations without receiving a raw secret', async () => {
    const request = vi.fn(async () => Object.freeze({
      status: 200,
      finalUrl: 'https://api.x.ai/v1/tts/voices',
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        voices: [{ voice_id: 'eve', name: 'Eve' }],
      })),
    }));
    const createAccountOperations = vi.fn(() => Object.freeze({ request }));
    const client = createXaiRealtimeVoiceUiClient({
      createAccountOperations,
    });

    await expect(client.fetchVoiceCatalog()).resolves.toEqual([{ id: 'eve', name: 'Eve', metadata: {} }]);
    expect(createAccountOperations).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(request).toHaveBeenCalledWith({
      operationId: 'voices',
      parameters: {},
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(request.mock.calls)).not.toContain('xai-account-key');
  });
});
