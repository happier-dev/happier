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
import { ConnectedServiceCredentialUnsupportedFormatError } from '@/api/client/connectedServiceCredentialApi';
import { AccountStoredContentClientUpgradeRequiredError } from '@/api/clientCompatibility/accountStoredContentActivation';
import type { Credentials, StoredCredentials } from '@/persistence';

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
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
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
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
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

  it('fetches plaintext credentials with token-only account custody', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'keyless',
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
        content: { t: 'plain' as const, v: record },
      })),
      getConnectedServiceCredentialSealed: vi.fn(async () => null),
    };
    const credentials: StoredCredentials = {
      token: 'token-only',
      encryption: null,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials,
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'keyless' }],
    })).resolves.toEqual(new Map([['openai-codex', record]]));
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable Account mode before selecting credential storage', async () => {
    const getConnectedServiceCredentialPlain = vi.fn(async () => null);
    const getConnectedServiceCredentialSealed = vi.fn(async () => ({
      sealed: { format: 'account_scoped_v1' as const, ciphertext: 'ciphertext' },
      metadata: { kind: 'oauth' as const },
    }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode unavailable');
      }),
      getConnectedServiceCredentialPlain,
      getConnectedServiceCredentialSealed,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: { token: 'token-only', encryption: null },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'locked' }],
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'account_mode_unavailable',
      contentKind: 'credential',
      serviceId: 'openai-codex',
      profileId: 'locked',
    });
    expect(getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('reports malformed authoritative plaintext credentials as typed corrupt without sealed fallback', async () => {
    const getConnectedServiceCredentialSealed = vi.fn(async () => null);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: {
          t: 'plain' as const,
          v: { v: 999, serviceId: 'openai-codex', profileId: 'work' },
        },
      })),
      getConnectedServiceCredentialSealed,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: {
        token: 't',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'stored_content_corrupt',
      contentKind: 'credential',
      serviceId: 'openai-codex',
      profileId: 'work',
    });
    expect(getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('reports authentication-failed authoritative sealed credentials as typed corrupt', async () => {
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'e2ee' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => null),
      getConnectedServiceCredentialSealed: vi.fn(async () => ({
        sealed: {
          format: 'account_scoped_v1' as const,
          ciphertext: 'authentication-failed-ciphertext',
        },
        metadata: { kind: 'oauth' as const },
      })),
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: {
        token: 't',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'stored_content_corrupt',
      contentKind: 'credential',
      serviceId: 'openai-codex',
      profileId: 'work',
    });
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

  it('does not probe plaintext credentials when the Account-mode probe errors', async () => {
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
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'account_mode_unavailable',
    });

    expect(api.getAccountEncryptionMode).toHaveBeenCalledTimes(1);
    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('preserves stored-content upgrade-required before selecting credential storage', async () => {
    const upgradeRequired = new AccountStoredContentClientUpgradeRequiredError(
      'server-too-old',
    );
    const getPlain = vi.fn(async () => null);
    const getSealed = vi.fn(async () => null);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw upgradeRequired;
      }),
      getConnectedServiceCredentialPlain: getPlain,
      getConnectedServiceCredentialSealed: getSealed,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: {
        token: 't',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toBe(upgradeRequired);

    expect(getPlain).not.toHaveBeenCalled();
    expect(getSealed).not.toHaveBeenCalled();
  });

  it('does not probe sealed credentials when Account mode is unknown', async () => {
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
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'account_mode_unavailable',
    });

    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(api.getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });

  it('does not reach unsupported plaintext storage when Account mode is unknown', async () => {
    const unsupported = new ConnectedServiceCredentialUnsupportedFormatError(
      'openai-codex',
      'work',
    );
    const getConnectedServiceCredentialSealed = vi.fn(async () => null);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        throw new Error('mode probe failed');
      }),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        throw unsupported;
      }),
      getConnectedServiceCredentialSealed,
    };

    await expect(resolveConnectedServiceCredentials({
      credentials: {
        token: 't',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(9),
        },
      },
      api: api as unknown as ConnectedServiceCredentialApi,
      bindings: [{ serviceId: 'openai-codex', profileId: 'work' }],
    })).rejects.toMatchObject({
      code: 'connected_service_stored_content_unavailable',
      reason: 'account_mode_unavailable',
    });
    expect(api.getConnectedServiceCredentialPlain).not.toHaveBeenCalled();
    expect(getConnectedServiceCredentialSealed).not.toHaveBeenCalled();
  });
});
