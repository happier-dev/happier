import { describe, expect, it } from 'vitest';

import { createOhMyPiConnectedServiceRuntimeAuthAdapter } from './createOhMyPiConnectedServiceRuntimeAuthAdapter';

describe('createOhMyPiConnectedServiceRuntimeAuthAdapter', () => {
  it('does not classify ambiguous OhMyPi runtime errors as provider-id connected services', () => {
    const adapter = createOhMyPiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'ohMyPi' },
      error: new Error('rate limit reached'),
      selection: {
        openaiProfileId: 'openai-work',
        geminiProfileId: 'gemini-work',
      },
    })).toBeNull();
  });

  it('reports independently active connected-service profiles for materialization diagnostics', async () => {
    const adapter = createOhMyPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.materializeActiveProfile({
      target: { agentId: 'ohMyPi' },
      selection: {
        openaiProfileId: 'openai-work',
        geminiProfileId: 'gemini-work',
      },
    })).resolves.toEqual({
      supported: true,
      activeProfiles: {
        openai: 'openai-work',
        gemini: 'gemini-work',
      },
    });
  });
});
