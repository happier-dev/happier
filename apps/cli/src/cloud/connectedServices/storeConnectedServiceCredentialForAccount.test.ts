import { describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  FeaturesResponseSchema,
  openConnectedServiceCredentialCiphertext,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { ConnectedServiceCredentialUnsupportedFormatError } from '@/api/client/connectedServiceCredentialApi';
import {
  storeConnectedServiceCredentialForAccount,
  type ConnectedServiceCredentialStorageApi,
} from './storeConnectedServiceCredentialForAccount';

const revision = 'csr_abcdefghijklmnopqrstuv';
type RegisterSealedCredentialArgs = Parameters<
  NonNullable<
    ConnectedServiceCredentialStorageApi[
      'registerConnectedServiceCredentialSealed'
    ]
  >
>[0];
function readyServerFeatures(payload: unknown): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    features: FeaturesResponseSchema.parse(payload),
  };
}

const currentServerFeatures = readyServerFeatures({
  features: {},
  capabilities: {
    connectedServices: {
      credentialDelete: { revisionGuard: true },
    },
    session: {
      runtimeActivity: { protocolVersion: 2 },
      pendingInput: { protocolVersion: 1 },
      publisherAuthority: { protocolVersion: 1 },
    },
  },
});
const releasedServerV021Features = readyServerFeatures({
  features: {
    sharing: {
      session: { enabled: true },
      public: { enabled: true },
      contentKeys: { enabled: true },
      pendingQueueV2: { enabled: true },
    },
  },
  capabilities: {},
});
const laterServerFeatures = readyServerFeatures({
  features: {},
  capabilities: {
    connectedServices: {
      credentialDelete: { revisionGuard: true },
    },
    session: {
      runtimeActivity: { protocolVersion: 3 },
      pendingInput: { protocolVersion: 2 },
      publisherAuthority: { protocolVersion: 2 },
    },
  },
});
const nonmatchingServerFeatures = readyServerFeatures({
  features: {
    sharing: {
      pendingQueueV2: { enabled: true },
      pendingDeliveryState: { enabled: true },
    },
  },
  capabilities: {},
});
const exactV021ServerContract = {
  mode: 'released_server_v0_2_1',
  runtimeActivity: 'legacy',
  pendingInput: 'released_server_v0_2_1',
  publisherAuthority: 'indeterminate',
  sessionConnectionEpoch: 1,
  socket: { connected: true },
} as const;
const currentServerContract = {
  mode: 'session_sync_v2_pending_input_v1',
  runtimeActivity: 'v2',
  pendingInput: 'v1',
  publisherAuthority: 'indeterminate',
  sessionConnectionEpoch: 2,
  socket: { connected: true },
} as const;

function createRecord(token = 'secret-token'): ConnectedServiceCredentialRecordV1 {
  return buildConnectedServiceCredentialRecord({
    now: 1_000,
    serviceId: 'github',
    profileId: 'work',
    kind: 'token',
    token: { token, providerAccountId: null, providerEmail: null },
  });
}

function releasedTokenRecord(
  record: ConnectedServiceCredentialRecordV1,
): ConnectedServiceCredentialRecordV1 {
  if (record.kind !== 'token') throw new Error('Expected token credential');
  return { ...record, oauth: null };
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
    getServerFeaturesSnapshot: async () => currentServerFeatures,
    registerConnectedServiceCredentialPlain: async () => ({ success: true, credentialRevision: revision }),
    registerConnectedServiceCredentialSealed: async () => ({ success: true, credentialRevision: revision }),
    ...overrides,
  };
}

describe('storeConnectedServiceCredentialForAccount', () => {
  it('does not overwrite an unsupported authoritative plaintext credential', async () => {
    const unsupported = new ConnectedServiceCredentialUnsupportedFormatError(
      'github',
      'work',
    );
    const registerPlain = vi.fn(async () => ({
      success: true as const,
      credentialRevision: revision,
    }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => {
        throw unsupported;
      },
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord('replacement-token'),
    })).rejects.toBe(unsupported);
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it('refuses a missing plaintext mutation on exact v0.2.1 before the content-only POST', async () => {
    const record = createRecord();
    const getServerFeaturesSnapshot = vi.fn(async () => releasedServerV021Features);
    const registerPlain = vi.fn(async (
      params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialPlain']>[0],
    ) => {
      expect(params).toEqual({
        serviceId: record.serviceId,
        profileId: record.profileId,
        content: { t: 'plain', v: releasedTokenRecord(record) },
      });
      return { success: true as const };
    });
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      record,
      serverContract: exactV021ServerContract,
    })).rejects.toMatchObject({
      code: 'connected_service_credential_legacy_unfenced_mutation_unsupported',
    });

    expect(getServerFeaturesSnapshot).toHaveBeenCalledOnce();
    expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it.each([
    'server-v0.2.1-dev.33.1',
    'server-v0.2.3-dev.35.1',
    'server-v0.2.4-dev.38.1',
  ])('refuses incidental content-only mutation for immutable %s with the byte-identical observed contract shape', async (_tag) => {
    const record = createRecord();
    const registerPlain = vi.fn(async () => ({ success: true as const }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot: async () => releasedServerV021Features,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record,
      serverContract: exactV021ServerContract,
    })).rejects.toMatchObject({
      code: 'connected_service_credential_legacy_unfenced_mutation_unsupported',
    });
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it('creates missing plaintext through the guarded current contract', async () => {
    const record = createRecord();
    const registerPlain = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot: async () => currentServerFeatures,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record,
    })).resolves.toEqual({ revisionSemantics: 'revisioned', credentialRevision: revision });

    expect(registerPlain).toHaveBeenCalledWith({
      serviceId: record.serviceId,
      profileId: record.profileId,
      content: { t: 'plain', v: releasedTokenRecord(record) },
      expectedCredentialRevision: null,
    });
  });

  it('rejects a guarded mutation response that omits the committed credential revision', async () => {
    const registerPlain = vi.fn(async () => ({ success: true as const }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot: async () => currentServerFeatures,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toMatchObject({
      code: 'connected_service_credential_revision_required',
    });
    expect(registerPlain).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'current cache to exact v0.2.1',
      currentServerFeatures,
      releasedServerV021Features,
      exactV021ServerContract,
      'legacy_rejected',
    ],
    [
      'exact v0.2.1 cache to current',
      releasedServerV021Features,
      currentServerFeatures,
      currentServerContract,
      'revisioned',
    ],
  ] as const)('forces authoritative feature refresh across a warm %s transition', async (
    _name,
    cached,
    authoritative,
    serverContract,
    expectedContract,
  ) => {
    const record = createRecord();
    const getServerFeaturesSnapshot = vi.fn(async (options?: Readonly<{ refresh?: boolean }>) =>
      options?.refresh === true ? authoritative : cached);
    const registerPlain = vi.fn(async (
      _params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialPlain']>[0],
    ) => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    const store = storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record,
      serverContract,
    });

    if (expectedContract === 'legacy_rejected') {
      await expect(store).rejects.toMatchObject({
        code: 'connected_service_credential_legacy_unfenced_mutation_unsupported',
      });
      expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
      expect(registerPlain).not.toHaveBeenCalled();
      return;
    }
    await expect(store).resolves.toEqual({
      revisionSemantics: 'revisioned',
      credentialRevision: revision,
    });
    expect(getServerFeaturesSnapshot).toHaveBeenCalledWith({ refresh: true });
    expect(registerPlain).toHaveBeenCalledWith({
      serviceId: record.serviceId,
      profileId: record.profileId,
      content: { t: 'plain', v: releasedTokenRecord(record) },
      expectedCredentialRevision: null,
    });
  });

  it('keeps a higher compatible protocol envelope on the guarded current write shape', async () => {
    const record = createRecord();
    const registerPlain = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot: async () => laterServerFeatures,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record,
    });

    expect(registerPlain).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredentialRevision: null,
    }));
  });

  it.each([
    ['nonmatching ready contract', nonmatchingServerFeatures],
    ['network-indeterminate contract', { status: 'error', reason: 'network' } as const],
  ])('fails closed before writing missing plaintext for an %s', async (_name, snapshot) => {
    const registerPlain = vi.fn(async () => ({ success: true as const, credentialRevision: revision }));
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => null,
      getServerFeaturesSnapshot: async () => snapshot,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toThrow('server credential mutation contract is indeterminate');
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it('reuses one sealed ciphertext and makes at most two writes after ambiguous unchanged results', async () => {
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
    const ciphertext = registerSealed.mock.calls[0]?.[0].sealed.ciphertext;
    expect(openConnectedServiceCredentialCiphertext({
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      ciphertext: ciphertext!,
    })?.value).toMatchObject({
      kind: 'token',
      oauth: null,
    });
    expect(getSealed).toHaveBeenCalledTimes(2);
  });

  it('seals the released token discriminator through data-key account encryption', async () => {
    const registerSealed = vi.fn(async (
      _input: RegisterSealedCredentialArgs,
    ) => ({
      success: true as const,
      credentialRevision: revision,
    }));
    const machineKey = new Uint8Array(32).fill(8);
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(7),
        machineKey,
      },
    };
    const api = createApi({
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await storeConnectedServiceCredentialForAccount({
      api,
      credentials,
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(4),
    });

    const ciphertext = registerSealed.mock.calls[0]?.[0].sealed.ciphertext;
    expect(openConnectedServiceCredentialCiphertext({
      material: {
        type: 'dataKey',
        machineKey,
      },
      ciphertext: ciphertext!,
    })?.value).toMatchObject({
      kind: 'token',
      oauth: null,
    });
  });

  it('preserves the original write error when the authoritative settlement read fails', async () => {
    const writeError = new Error('connection closed after request');
    const getSealed = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('settlement read unavailable'));
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

  it('adopts an exact committed sealed write without posting again', async () => {
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

  it('rejects an ambiguous exact stored write when the settlement read omits the committed revision', async () => {
    let written: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0] | null = null;
    const getSealed = vi.fn(async () => written === null ? null : ({
      revisionSemantics: 'legacy_unfenced' as const,
      credentialRevision: null,
      sealed: written.sealed,
      metadata: written.metadata!,
    }));
    const registerSealed = vi.fn(async (
      params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0],
    ) => {
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
    })).rejects.toMatchObject({
      code: 'connected_service_credential_revision_required',
    });
    expect(registerSealed).toHaveBeenCalledTimes(1);
    expect(getSealed).toHaveBeenCalledTimes(2);
  });

  it('refuses a read-derived legacy_unfenced sealed mutation before POST or ambiguous settlement', async () => {
    const registerSealed = vi.fn(async (
      params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialSealed']>[0],
    ) => {
      expect(params).not.toHaveProperty('expectedCredentialRevision');
      return { success: true as const };
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: async () => ({
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        sealed: { format: 'account_scoped_v1', ciphertext: 'old-ciphertext' },
        metadata: { kind: 'token' },
      }),
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    })).rejects.toMatchObject({
      code: 'connected_service_credential_legacy_unfenced_mutation_unsupported',
    });
    expect(registerSealed).not.toHaveBeenCalled();
  });

  it('refuses an existing plaintext legacy record without probing features or issuing POST', async () => {
    const record = createRecord();
    const getServerFeaturesSnapshot = vi.fn(async () => currentServerFeatures);
    const registerPlain = vi.fn(async (
      params: Parameters<ConnectedServiceCredentialStorageApi['registerConnectedServiceCredentialPlain']>[0],
    ) => {
      expect(params).toEqual({
        serviceId: record.serviceId,
        profileId: record.profileId,
        content: { t: 'plain', v: releasedTokenRecord(record) },
      });
      return { success: true as const };
    });
    const api = createApi({
      getAccountEncryptionMode: async () => 'plain',
      getConnectedServiceCredentialPlain: async () => ({
        revisionSemantics: 'legacy_unfenced',
        credentialRevision: null,
        content: { t: 'plain', v: createRecord('previous-token') },
      }),
      getServerFeaturesSnapshot,
      registerConnectedServiceCredentialPlain: registerPlain,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record,
    })).rejects.toMatchObject({
      code: 'connected_service_credential_legacy_unfenced_mutation_unsupported',
    });
    expect(getServerFeaturesSnapshot).not.toHaveBeenCalled();
    expect(registerPlain).not.toHaveBeenCalled();
  });

  it('reports superseded and does not retry when the revision changes during settlement', async () => {
    const nextRevision = 'csr_bcdefghijklmnopqrstuvw';
    const getSealed = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        revisionSemantics: 'revisioned',
        credentialRevision: nextRevision,
        sealed: { format: 'account_scoped_v1', ciphertext: 'other' },
        metadata: { kind: 'token' },
      });
    const registerSealed = vi.fn(async () => {
      throw new Error('connection closed while another writer committed');
    });
    const api = createApi({
      getConnectedServiceCredentialSealed: getSealed,
      registerConnectedServiceCredentialSealed: registerSealed,
    });

    await expect(storeConnectedServiceCredentialForAccount({
      api,
      credentials: createCredentials(),
      record: createRecord(),
    })).rejects.toMatchObject({
      name: 'ConnectedServiceCredentialStorageSupersededError',
      reason: 'revision_mismatch',
      credentialRevision: nextRevision,
    });
    expect(registerSealed).toHaveBeenCalledTimes(1);
  });
});
