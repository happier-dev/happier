import { describe, expect, it } from 'vitest';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import type { ConnectedServiceAuthGroupApi, ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';
import { resolveClaudeModelProbeTarget } from './resolveClaudeModelProbeTarget';

const credentials: Credentials = {
  token: 'account-token',
  encryption: { type: 'legacy', secret: new Uint8Array(32) },
};

function anthropicRecord(token: string): ConnectedServiceCredentialRecordV1 {
  return {
    v: 1,
    serviceId: 'anthropic',
    profileId: 'selected-account',
    kind: 'token',
    token: { token, providerAccountId: null, providerEmail: null, raw: null },
    oauth: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
  };
}

describe('resolveClaudeModelProbeTarget', () => {
  it('uses bearer auth before an API key from the same effective environment', async () => {
    const target = await resolveClaudeModelProbeTarget({
      processEnv: {
        ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_API_KEY: 'ambient-api-key',
      },
    });

    expect(target).toMatchObject({
      baseUrl: 'https://gateway.example/anthropic',
      credential: { kind: 'bearer', value: 'gateway-token' },
    });
  });

  it('fails closed on an invalid explicit endpoint', async () => {
    await expect(resolveClaudeModelProbeTarget({
      processEnv: {
        ANTHROPIC_BASE_URL: 'not a url',
        ANTHROPIC_AUTH_TOKEN: 'must-not-be-rehomed',
      },
    })).resolves.toBeNull();
  });

  it('uses the selected connected Anthropic account instead of ambient auth', async () => {
    const record = anthropicRecord('selected-api-key');
    const api: ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi = {
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialSealed: async () => null,
      getConnectedServiceCredentialPlain: async () => ({
        content: { t: 'plain', v: record },
        revisionSemantics: 'revisioned',
        credentialRevision: 7,
      }),
      listConnectedServiceAuthGroups: async () => [],
      getConnectedServiceAuthGroup: async () => null,
    };

    const target = await resolveClaudeModelProbeTarget({
      credentials,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          anthropic: {
            source: 'connected',
            selection: 'profile',
            profileId: 'selected-account',
          },
        },
      },
      processEnv: { ANTHROPIC_API_KEY: 'wrong-ambient-key' },
      createCredentialApi: () => api,
    });

    expect(target?.credential).toEqual({ kind: 'api_key', value: 'selected-api-key' });
  });

  it('projects a selected built-in gateway profile without mutating ambient auth', async () => {
    const target = await resolveClaudeModelProbeTarget({
      credentials,
      profileId: 'deepseek',
      accountSettings: {},
      processEnv: {
        DEEPSEEK_AUTH_TOKEN: 'deepseek-token',
        ANTHROPIC_API_KEY: 'unrelated-key',
      },
    });

    expect(target).toMatchObject({
      baseUrl: 'https://api.deepseek.com/anthropic',
      credential: { kind: 'bearer', value: 'deepseek-token' },
    });
  });
});
