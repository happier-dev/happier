import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import {
  storeConnectedServiceCredentialForAccount,
  type ConnectedServiceCredentialStorageApi,
} from './storeConnectedServiceCredentialForAccount';

const revision = 'csr_abcdefghijklmnopqrstuv';

function createRecord(): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now: 1_000,
    serviceId: 'anthropic',
    profileId: 'default',
    kind: 'token',
    token: { token: 'secret-token', providerAccountId: null, providerEmail: null },
  });
}

function createCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
  };
}

function createApi(overrides: Partial<ConnectedServiceCredentialStorageApi>): ConnectedServiceCredentialStorageApi {
  return {
    getAccountEncryptionMode: async () => 'e2ee',
    getConnectedServiceCredentialPlain: async () => null,
    getConnectedServiceCredentialSealed: async () => null,
    registerConnectedServiceCredentialPlain: async () => ({ success: true, credentialRevision: revision }),
    registerConnectedServiceCredentialSealed: async () => ({ success: true, credentialRevision: revision }),
    ...overrides,
  };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it('publishes the credential organization as sealed public metadata', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1000, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth',
      oauth: { accessToken: 'access', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null,
        providerAccountId: 'same-user', providerEmail: null, raw: { claudeAiOauth: { organizationUuid: 'org-a' } } },
    });
    let metadata: unknown;
    await storeConnectedServiceCredentialForAccount({
      api: createApi({ registerConnectedServiceCredentialSealed: async (params) => {
        metadata = params.metadata;
        return { success: true, credentialRevision: revision };
      } }), credentials: createCredentials(), record,
    });
    expect(metadata).toMatchObject({ providerAccountId: 'same-user', providerOrganizationId: 'org-a' });
  });

  it('reports an unresolved native import write as unknown even without cancellation', async () => {
    let reads = 0;
    await expect(storeConnectedServiceCredentialForAccount({
      api: createApi({
        getConnectedServiceCredentialSealed: async () => { if (reads++ > 0) throw new Error('readback unavailable'); return null; },
        registerConnectedServiceCredentialSealed: async () => { throw new Error('connection lost after dispatch'); },
      }), credentials: createCredentials(), record: createRecord(), identityPolicy: 'same_account_or_empty',
    })).rejects.toMatchObject({ code: 'storage_result_unknown' });
  });
  it('keeps the admitted identity revision when a concurrent credential mutation supersedes import', async () => {
    const registerSealed = vi.fn(async () => ({ error: 'connect_credential_mutation_superseded' as const, reason: 'revision_mismatch' as const, credentialRevision: 'csr_zyxwvutsrqponmlkjihgfe' }));
    const record = buildConnectedServiceCredentialRecord({
      now: 1000, serviceId: 'openai-codex', profileId: 'personal', kind: 'oauth',
      oauth: { accessToken: 'synthetic', refreshToken: 'synthetic-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'account-a', providerEmail: null },
    });
    await expect(storeConnectedServiceCredentialForAccount({
      api: createApi({ getConnectedServiceCredentialSealed: async () => ({ revisionSemantics: 'revisioned', credentialRevision: revision, sealed: { format: 'account_scoped_v1', ciphertext: 'synthetic' }, metadata: { kind: 'oauth', providerAccountId: 'account-a' } }), registerConnectedServiceCredentialSealed: registerSealed }),
      credentials: createCredentials(), record, identityPolicy: 'same_account_or_empty',
    })).rejects.toMatchObject({ reason: 'revision_mismatch' });
    expect(registerSealed).toHaveBeenCalledOnce();
    expect(registerSealed).toHaveBeenCalledWith(expect.objectContaining({ expectedCredentialRevision: revision }));
  });
  it('preserves a committed native import result when cancellation arrives during its write', async () => {
    const controller = new AbortController();
    await expect(storeConnectedServiceCredentialForAccount({
      api: createApi({ registerConnectedServiceCredentialSealed: async () => { controller.abort(); return { success: true, credentialRevision: revision }; } }),
      credentials: createCredentials(), record: createRecord(), signal: controller.signal,
    })).resolves.toMatchObject({ credentialRevision: revision });
  });
  it('reports uncertain storage instead of cancellation when an entered write cannot be settled', async () => {
    const controller = new AbortController();
    let reads = 0;
    await expect(storeConnectedServiceCredentialForAccount({
      api: createApi({
        getConnectedServiceCredentialSealed: async () => { if (reads++ > 0) throw new Error('readback unavailable'); return null; },
        registerConnectedServiceCredentialSealed: async () => { controller.abort(); throw new Error('connection lost after dispatch'); },
      }), credentials: createCredentials(), record: createRecord(), signal: controller.signal,
    })).rejects.toMatchObject({ code: 'storage_result_unknown' });
  });
  it('does not write a native import after cancellation during revision preparation', async () => {
    const controller = new AbortController();
    const registerSealed = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    await expect(storeConnectedServiceCredentialForAccount({
      api: createApi({ getConnectedServiceCredentialSealed: async () => { controller.abort(); return null; }, registerConnectedServiceCredentialSealed: registerSealed }),
      credentials: createCredentials(), record: createRecord(), signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(registerSealed).not.toHaveBeenCalled();
  });
  it('refuses native import into a profile owned by another account before a sealed write', async () => {
    const registerSealed = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned', credentialRevision: revision,
        sealed: { format: 'account_scoped_v1', ciphertext: 'synthetic' },
        metadata: { kind: 'oauth', providerAccountId: 'account-a' },
      }),
      registerConnectedServiceCredentialSealed: registerSealed,
    });
    const record = buildConnectedServiceCredentialRecord({
      now: 1000, serviceId: 'openai-codex', profileId: 'default', kind: 'oauth',
      oauth: { accessToken: 'synthetic', refreshToken: 'synthetic-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'account-b', providerEmail: null },
    });
    await expect(storeConnectedServiceCredentialForAccount({
      api, credentials: createCredentials(), record, identityPolicy: 'same_account_or_empty',
    })).rejects.toMatchObject({ code: 'profile_conflict' });
    expect(registerSealed).not.toHaveBeenCalled();
  });
  it('reuses one sealed ciphertext when an ambiguous write settles unchanged before retry', async () => {
    const getSealed = vi.fn(async () => null);
    const registerSealed = vi.fn()
      .mockRejectedValueOnce(new Error('connection closed after request'))
      .mockResolvedValueOnce({ success: true, credentialRevision: revision });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
    })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });

    expect(registerSealed).toHaveBeenCalledTimes(2);
    expect(registerSealed.mock.calls[0]?.[0]).toEqual(registerSealed.mock.calls[1]?.[0]);
    expect(registerSealed.mock.calls[0]?.[0]).toMatchObject({ expectedCredentialRevision: null });
    expect(getSealed).toHaveBeenCalledTimes(2);
  });

  it('adopts a committed ambiguous sealed write without posting again', async () => {
    let written: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0] | null = null;
    const getSealed = vi.fn(async () => written === null ? null : ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision: revision,
      sealed: written.sealed,
      metadata: written.metadata!,
    }));
    const registerSealed = vi.fn(async (params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0]) => {
      written = params;
      throw new Error('connection closed after commit');
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(5),
    })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });

  it('does not retry a definite client rejection', async () => {
    const registerSealed = vi.fn(async () => {
      throw new HttpStatusError(400, 'invalid request');
    });
    const api = createApi({ registerConnectedServiceCredentialSealed: registerSealed });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toMatchObject({ response: { status: 400 } });

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });

  it('does not manufacture a credential revision for a legacy-unfenced write', async () => {
    const registerSealed = vi.fn<
      ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']
    >(async () => ({ success: true as const }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        sealed: { format: 'account_scoped_v1', ciphertext: 'existing' },
        metadata: { kind: 'token' },
      }),
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).resolves.toEqual({
      revisionSemantics: 'legacy_unfenced',
      credentialRevision: null,
    });
    expect(registerSealed.mock.calls[0]?.[0]).not.toHaveProperty('expectedCredentialRevision');
  });

  it('does not post again when an ambiguous result cannot be settled by an authoritative read', async () => {
    const getSealed = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('settlement read unavailable'));
    const writeError = new Error('connection closed after request');
    const registerSealed = vi.fn(async () => {
      throw writeError;
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toBe(writeError);

    expect(registerSealed).toHaveBeenCalledTimes(1);
  });
});
