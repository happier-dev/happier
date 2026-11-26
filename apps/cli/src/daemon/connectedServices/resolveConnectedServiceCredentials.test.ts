import { describe, expect, it, vi } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import {
  ConnectedServiceCredentialBindingMismatchError,
  ConnectedServiceCredentialResolutionError,
  resolveConnectedServiceCredentials,
  resolveConnectedServiceCredentialsWithRevisions,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { ConnectedServiceCredentialApi } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';

describe('resolveConnectedServiceCredentials', () => {
  it.each([
    ['service', 'claude-subscription', 'work'],
    ['profile', 'openai-codex', 'other'],
  ] as const)('rejects a valid plaintext record with the wrong requested %s without sealed fallback', async (_field, serviceId, profileId) => {
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId,
      profileId,
      kind: 'oauth',
      oauth: { accessToken: 'secret', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'unknown' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialBindingMismatchError',
      code: 'connected_service_credential_binding_mismatch',
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('rejects a valid sealed record bound to another profile', async () => {
    const secret = new Uint8Array(32).fill(9);
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'oauth',
      oauth: { accessToken: 'secret', refreshToken: 'refresh', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret },
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'oauth' as const },
      })),
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toBeInstanceOf(ConnectedServiceCredentialBindingMismatchError);
  });

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
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
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
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    });

    expect(opened.get('openai-codex')?.serviceId).toBe('openai-codex');
    expect(opened.get('openai-codex')?.profileId).toBe('work');
  });

  it('preserves the exact fetched credential revision beside the decrypted record', async () => {
    const secret = new Uint8Array(32).fill(9);
    const record = buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret },
      payload: record,
      randomBytes: (len) => new Uint8Array(len).fill(1),
    });

    const resolved = await resolveConnectedServiceCredentialsWithRevisions({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      api: {
        getConnectedServiceCredentialSealed: async () => ({
          revisionSemantics: 'revisioned' as const,
          credentialRevision: 'csr_abcdefghijklmnopqrstuv',
          sealed: { format: 'account_scoped_v1' as const, ciphertext },
          metadata: { kind: 'oauth' as const },
        }),
      } as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    });

    expect(resolved.get('openai-codex')).toEqual({
      record,
      revisionSemantics: 'revisioned',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
  });

  it('fetches plaintext connected service credentials for plaintext accounts', async () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-at',
        refreshToken: 'plain-rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it.each([
    ['confirmed_missing', []],
    ['present_but_unusable', [{ profileId: 'batiplus', status: 'connected' }]],
    ['unknown', null],
  ] as const)('classifies an unavailable exact credential as %s from current authority', async (kind, profiles) => {
    const api = {
      listConnectedServiceProfiles: vi.fn(async ({ forceRefresh }: { forceRefresh?: boolean }) => {
        if (!forceRefresh) return { serviceId: 'claude-subscription', profiles: [{ profileId: 'batiplus', status: 'connected' }] };
        if (profiles === null) throw new Error('offline');
        return { serviceId: 'claude-subscription', profiles };
      }),
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'claude-subscription', profileId: 'batiplus' }],
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialResolutionError',
      kind,
      serviceId: 'claude-subscription',
      profileId: 'batiplus',
    });

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'claude-subscription', profileId: 'batiplus' }],
    })).rejects.toBeInstanceOf(ConnectedServiceCredentialResolutionError);
  });

  it.each(['plain', 'e2ee'] as const)('keeps a failed %s credential read unknown', async (mode) => {
    const listConnectedServiceProfiles = vi.fn(async () => ({
      serviceId: 'claude-subscription' as const,
      profiles: [],
    }));
    const failRead = async () => { throw new Error('offline'); };
    const api = {
      getAccountEncryptionMode: async () => mode,
      getConnectedServiceCredentialPlain: failRead,
      getConnectedServiceCredentialSealed: failRead,
      listConnectedServiceProfiles,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      api,
      bindings: [{ serviceId: 'claude-subscription', profileId: 'work' }],
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialResolutionError',
      kind: 'unknown',
      serviceId: 'claude-subscription',
      profileId: 'work',
    });
    expect(listConnectedServiceProfiles).not.toHaveBeenCalled();
  });

  it('falls back to plaintext credentials when the account-mode probe errors', async () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-at',
        refreshToken: 'plain-rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('falls back to sealed credentials when the account-mode probe errors and plaintext read fails', async () => {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'sealed-at',
        refreshToken: 'sealed-rt',
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
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw new Error('plain read failed');
      }),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        sealed: { format: 'account_scoped_v1' as const, ciphertext },
        metadata: { kind: 'oauth' as const },
      })),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({ serviceId: 'openai-codex', profileId: 'work' });
  });
});
