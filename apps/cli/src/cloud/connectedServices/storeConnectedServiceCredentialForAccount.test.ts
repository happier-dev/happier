import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealConnectedServiceCredentialCiphertext,
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
  it('refuses changing the existing provider identity when the connect target requires the same account', async () => {
    const register = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const existing = createRecord();
    if (existing.kind !== 'token') throw new Error('Expected token record');
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: { ...existing, token: { ...existing.token!, providerAccountId: 'previous-account' } } }, revisionSemantics: 'revisioned', credentialRevision: revision }),
      registerConnectedServiceCredentialPlain: register,
    });
    await expect(storeConnectedServiceCredentialForAccount({ api, credentials: createCredentials(), record: existing, requireSameProviderAccount: true })).rejects.toThrow(/identity/);
    expect(register).not.toHaveBeenCalled();
  });

  it('uses decrypted identity rather than mutable relay metadata for encrypted reconnect protection', async () => {
    const base = createRecord();
    if (base.kind !== 'token') throw new Error('Expected token');
    const previous = { ...base, token: { ...base.token, providerAccountId: 'previous-account' } };
    const credentials = createCredentials();
    if (credentials.encryption.type !== 'legacy') throw new Error('Expected legacy encryption');
    const ciphertext = sealConnectedServiceCredentialCiphertext({ material: { type: 'legacy', secret: credentials.encryption.secret }, payload: previous, randomBytes: (length) => new Uint8Array(length).fill(6) });
    const register = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'revisioned', credentialRevision: revision,
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: { kind: 'token', providerAccountId: null },
      }),
      registerConnectedServiceCredentialSealed: register,
    });
    await expect(storeConnectedServiceCredentialForAccount({ api, credentials, record: base, requireSameProviderAccount: true })).rejects.toThrow(/identity/);
    expect(register).not.toHaveBeenCalled();
  });

  it('reports an unknown storage result when cancellation occurs after the credential POST is issued', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const api = createApi({ registerConnectedServiceCredentialSealed: async (request) => {
      observedSignal = request.signal;
      controller.abort();
      throw new Error('transport cancelled after send');
    } });
    await expect(storeConnectedServiceCredentialForAccount({ api, credentials: createCredentials(), record: createRecord(), signal: controller.signal })).rejects.toThrow(/storage result is unknown/);
    expect(observedSignal).toBe(controller.signal);
  });

  it('does not post after the containing operation is cancelled during the revision read', async () => {
    const controller = new AbortController();
    const register = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => { controller.abort(); return null; },
      registerConnectedServiceCredentialSealed: register,
    });
    await expect(storeConnectedServiceCredentialForAccount({ api, credentials: createCredentials(), record: createRecord(), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['unreadable', 'wrong_binding', 'invalid_schema'] as const)('refuses %s encrypted records before replacing a connected account', async (variant) => {
    const credentials = createCredentials();
    if (credentials.encryption.type !== 'legacy') throw new Error('Expected legacy encryption');
    const payload = variant === 'wrong_binding' ? { ...createRecord(), profileId: 'other-profile' }
      : variant === 'invalid_schema' ? { serviceId: 'anthropic', profileId: 'default' } : createRecord();
    const ciphertext = variant === 'unreadable' ? 'unreadable'
      : sealConnectedServiceCredentialCiphertext({ material: { type: 'legacy', secret: credentials.encryption.secret }, payload, randomBytes: (length) => new Uint8Array(length).fill(6) });
    const register = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({ revisionSemantics: 'revisioned', credentialRevision: revision, sealed: { format: 'account_scoped_v1', ciphertext }, metadata: { kind: 'token', providerAccountId: null } }),
      registerConnectedServiceCredentialSealed: register,
    });
    await expect(storeConnectedServiceCredentialForAccount({ api, credentials, record: createRecord(), requireSameProviderAccount: true })).rejects.toThrow(/identity/);
    expect(register).not.toHaveBeenCalled();
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
