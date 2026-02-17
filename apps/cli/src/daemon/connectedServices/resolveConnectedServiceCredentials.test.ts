import { describe, expect, it } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

describe('resolveConnectedServiceCredentials', () => {
  it('fetches and opens sealed connected service credentials', async () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'at',
        refreshToken: 'rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });

    const api = {
      getConnectedServiceCredentialSealed: async () => ({
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'oauth' as const },
      }),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    const opened = await resolveConnectedServiceCredentials({
      credentials,
      api: api as unknown as ApiClient,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    });

    expect(opened.get('openai-codex')?.serviceId).toBe('openai-codex');
    expect(opened.get('openai-codex')?.profileId).toBe('work');
  });
});
