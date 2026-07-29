import { describe, expect, it } from 'vitest';

import { projectOpenAiRealtimeCredentialReadiness } from './credentialReadiness.js';

describe('OpenAI Realtime credential readiness', () => {
  const readySavedSecret = {
    accountProfile: {},
    savedSecret: { status: 'ready' as const },
  };
  const missingSavedSecret = {
    accountProfile: {},
    savedSecret: { status: 'missing' as const },
  };

  it('defers canonical OpenAI-purpose readiness to the daemon action owner', () => {
    expect(projectOpenAiRealtimeCredentialReadiness({
      authentication: {
        source: 'connected_service_api_key',
      },
    }, readySavedSecret)).toMatchObject({ status: 'unknown' });
    expect(projectOpenAiRealtimeCredentialReadiness({
      authentication: {
        source: 'connected_service_oauth',
      },
    }, readySavedSecret)).toMatchObject({
      status: 'unknown',
      detailKey: 'settingsVoice.realtimeProviders.authentication.chooseAccount',
    });
  });

  it('reports only the generic host SavedSecret readiness for the SavedSecret source', () => {
    expect(projectOpenAiRealtimeCredentialReadiness({}, readySavedSecret))
      .toMatchObject({ status: 'ready' });
    expect(projectOpenAiRealtimeCredentialReadiness({}, missingSavedSecret))
      .toMatchObject({ status: 'missing' });
  });
});
