import { describe, expect, it } from 'vitest';

import { PluginConnectedAccountDescriptorContributionV2Schema } from './connectedAccountDescriptors.js';

describe('plugin SDK connected account descriptor manifest surface', () => {
  it('validates plugin connected account descriptor contributions without protocol-internal imports', () => {
    const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
      id: 'example.connectedAccount',
      version: '1',
      kind: 'auth.connectedAccount',
      displayKey: 'plugins.example.connectedAccount.title',
      credentialKinds: ['token'],
      defaultCredentialKind: 'token',
      connectModes: [{
        targetId: 'example',
        mode: 'token',
        credentialKind: 'token',
        default: true,
        tokenKind: 'personal-access-token',
      }],
      tokenSetup: {
        tokenKind: 'personal-access-token',
        promptLabelKey: 'plugins.example.connectedAccount.tokenPrompt',
        missingValueErrorKey: 'plugins.example.connectedAccount.missingToken',
      },
      ui: {
        connectCommand: 'happier connect example --token',
        oauthAddActionModes: [],
      },
      materialization: {
        materializationKinds: ['scm_hosting_token'],
      },
    });

    expect(descriptor.id).toBe('example.connectedAccount');
  });
});
