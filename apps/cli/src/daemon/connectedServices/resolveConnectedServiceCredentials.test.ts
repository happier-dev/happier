import { describe, expect, it, vi } from 'vitest';

import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import {
  ConnectedServiceCredentialBindingMismatchError,
  ConnectedServiceCredentialResolutionError,
  resolveConnectedServiceCredentialResolutions,
  resolveConnectedServiceCredentials,
} from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { ConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';

describe('resolveConnectedServiceCredentials', () => {
  it('rejects a valid misbound plaintext record without falling through to sealed storage', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'other',
      kind: 'oauth',
      oauth: { accessToken: 'at', refreshToken: 'rt', idToken: null, scope: null, tokenType: null, providerAccountId: null, providerEmail: null },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => { throw new Error('mode unavailable'); }),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) } },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toBeInstanceOf(ConnectedServiceCredentialBindingMismatchError);
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
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
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    });

    expect(opened.get('openai-codex')?.serviceId).toBe('openai-codex');
    expect(opened.get('openai-codex')?.profileId).toBe('work');
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('preserves the server credential revision with the resolved plaintext credential', async () => {
    const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-at',
        refreshToken: 'plain-rt',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct-work',
        providerEmail: null,
      },
    });
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentialResolutions({
      credentials,
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', {
      record,
      revisionSemantics: 'revisioned',
      credentialRevision,
    }]]));
  });

  it('throws a structured missing-credential error with service/profile identity', async () => {
    const api = {
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
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'claude-subscription', profileId: 'batiplus' }],
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialResolutionError',
      kind: 'missing_credential',
      serviceId: 'claude-subscription',
      profileId: 'batiplus',
    });

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'claude-subscription', profileId: 'batiplus' }],
    })).rejects.toBeInstanceOf(ConnectedServiceCredentialResolutionError);
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
      getConnectedServiceCredentialPlain: vi.fn(async () => ({ content: { t: 'plain' as const, v: record } })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) },
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('falls back to sealed credentials when unknown account mode cannot read plaintext credentials', async () => {
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
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));

    expect(api.getConnectedServiceCredentialPlain).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(api.getConnectedServiceCredentialSealed).toHaveBeenCalledWith({
      serviceId: 'openai-codex',
      profileId: 'work',
    });
  });
});
