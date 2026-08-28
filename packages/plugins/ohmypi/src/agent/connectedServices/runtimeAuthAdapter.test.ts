import { describe, expect, it } from 'vitest';

import { createOhMyPiConnectedServiceRuntimeAuthAdapter } from './runtimeAuthAdapter.js';

describe('OhMyPi runtime auth adapter', () => {
  it('projects the generic selected service without built-in profile field names', async () => {
    const adapter = createOhMyPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.materializeActiveProfile({
      target: { agentId: 'ohmypi' },
      selection: {
        kind: 'profile',
        serviceId: 'external.example/auth',
        profileId: 'external-work',
      },
    })).resolves.toEqual({
      supported: true,
      activeProfiles: { 'external.example/auth': 'external-work' },
    });
  });
});
