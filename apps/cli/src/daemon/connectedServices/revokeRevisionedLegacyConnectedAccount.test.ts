import { describe, expect, it, vi } from 'vitest';

import {
  revokeRevisionedLegacyConnectedAccount,
} from './revokeRevisionedLegacyConnectedAccount';

const service = Object.freeze({
  pluginId: 'happier.scm.hosting.github',
  localId: 'github-account',
});
const account = Object.freeze({ service, accountId: 'work' });
const credentialRevision = 'csr_0123456789ABCDEFGHJKMNPQRS';

describe('revokeRevisionedLegacyConnectedAccount', () => {
  it('rechecks the exact revisioned transport after mode discovery and before credential read issuance', async () => {
    let transport: 'revisioned' | 'exact-old' = 'revisioned';
    const readCredential = vi.fn(async () => null);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => {
        transport = 'exact-old';
        return 'plain' as const;
      }),
      getConnectedServiceCredentialPlain: readCredential,
      getConnectedServiceCredentialSealed: vi.fn(),
      deleteConnectedServiceCredentialRevisioned: vi.fn(),
    };

    await expect(revokeRevisionedLegacyConnectedAccount({
      account,
      serviceId: 'github',
      cleanupGroupReferences: false,
      api,
      resolvePeerOperationTransport: () => transport === 'revisioned'
        ? {
            kind: 'legacy',
            peerClass: 'revisioned_v2_v3',
            serviceId: 'github',
          }
        : {
            kind: 'legacy',
            peerClass: 'exact_v0_2_1',
            serviceId: 'github',
          },
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(readCredential).not.toHaveBeenCalled();
  });

  it('does not report a stale null credential read as a successful delete', async () => {
    let transport: 'revisioned' | 'exact-old' = 'revisioned';
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        transport = 'exact-old';
        return null;
      }),
      getConnectedServiceCredentialSealed: vi.fn(),
      deleteConnectedServiceCredentialRevisioned: vi.fn(),
    };

    await expect(revokeRevisionedLegacyConnectedAccount({
      account,
      serviceId: 'github',
      cleanupGroupReferences: false,
      api,
      resolvePeerOperationTransport: () => transport === 'revisioned'
        ? {
            kind: 'legacy',
            peerClass: 'revisioned_v2_v3',
            serviceId: 'github',
          }
        : {
            kind: 'legacy',
            peerClass: 'exact_v0_2_1',
            serviceId: 'github',
          },
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
  });

  it('rechecks the exact revisioned transport after credential discovery and before guarded delete', async () => {
    let transport: 'revisioned' | 'exact-old' = 'revisioned';
    const deleteCredential = vi.fn(async () => undefined);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => {
        transport = 'exact-old';
        return {
          revisionSemantics: 'revisioned' as const,
          credentialRevision,
          content: {
            t: 'plain' as const,
            v: {
              v: 1 as const,
              serviceId: 'github' as const,
              profileId: 'work',
              createdAt: 1,
              updatedAt: 1,
              expiresAt: null,
              kind: 'token' as const,
              oauth: null,
              token: {
                token: 'secret',
                providerAccountId: null,
                providerEmail: null,
                raw: null,
              },
            },
          },
        };
      }),
      getConnectedServiceCredentialSealed: vi.fn(),
      deleteConnectedServiceCredentialRevisioned: deleteCredential,
    };

    await expect(revokeRevisionedLegacyConnectedAccount({
      account,
      serviceId: 'github',
      cleanupGroupReferences: false,
      api,
      resolvePeerOperationTransport: () => transport === 'revisioned'
        ? {
            kind: 'legacy',
            peerClass: 'revisioned_v2_v3',
            serviceId: 'github',
          }
        : {
            kind: 'legacy',
            peerClass: 'exact_v0_2_1',
            serviceId: 'github',
          },
    })).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it('uses the discovered revision as the sole guard for the matching V3 delete', async () => {
    const deleteCredential = vi.fn(async () => undefined);
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        revisionSemantics: 'revisioned' as const,
        credentialRevision,
        content: {
          t: 'plain' as const,
          v: {
            v: 1 as const,
            serviceId: 'github' as const,
            profileId: 'work',
            createdAt: 1,
            updatedAt: 1,
            expiresAt: null,
            kind: 'token' as const,
            oauth: null,
            token: {
              token: 'secret',
              providerAccountId: null,
              providerEmail: null,
              raw: null,
            },
          },
        },
      })),
      getConnectedServiceCredentialSealed: vi.fn(),
      deleteConnectedServiceCredentialRevisioned: deleteCredential,
    };

    await expect(revokeRevisionedLegacyConnectedAccount({
      account,
      serviceId: 'github',
      cleanupGroupReferences: true,
      api,
      resolvePeerOperationTransport: () => ({
        kind: 'legacy',
        peerClass: 'revisioned_v2_v3',
        serviceId: 'github',
      }),
    })).resolves.toEqual({
      status: 'deleted',
      remoteStatus: 'remoteUnsupported',
    });
    expect(deleteCredential).toHaveBeenCalledWith({
      storageMode: 'plain',
      serviceId: 'github',
      profileId: 'work',
      expectedCredentialRevision: credentialRevision,
      cleanupGroupReferences: true,
    });
  });
});
