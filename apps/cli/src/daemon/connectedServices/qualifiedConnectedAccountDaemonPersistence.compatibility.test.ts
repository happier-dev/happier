import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceCredentialRecordV1Schema,
  FeaturesResponseSchema,
  type BuiltInLegacyConnectedServiceId,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createQualifiedConnectedAccountDaemonPersistence,
} from './qualifiedConnectedAccountDaemonPersistence';

const claudeSubscriptionService = Object.freeze({
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
});
const credentialRevision = 'csr_abcdefghijklmnopqrstuv';
const revisionedPeerFeatures = FeaturesResponseSchema.parse({
  features: {},
  capabilities: {
    connectedServices: {
      credentialDelete: { revisionGuard: true },
    },
  },
});
const exactPeerFeatures = FeaturesResponseSchema.parse({
  features: {
    sharing: {
      pendingQueueV2: { enabled: true },
    },
  },
  capabilities: {},
});
const legacyRecord = buildConnectedServiceCredentialRecord({
  now: 1_000,
  serviceId: 'claude-subscription',
  profileId: 'work',
  kind: 'token',
  token: {
    token: 'setup-token',
    providerAccountId: 'provider-account',
    providerEmail: 'person@example.test',
  },
});
// Golden wire record emitted by cli-v0.2.1 at
// b1d15a8a9c241737d1ca9b167459901e6259173a.
const unsupportedGeminiOauthRecord =
  ConnectedServiceCredentialRecordV1Schema.parse({
    v: 1,
    serviceId: 'gemini',
    profileId: 'old-oauth',
    kind: 'oauth',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: null,
    oauth: {
      accessToken: 'historical-access',
      refreshToken: 'historical-refresh',
      idToken: null,
      scope: null,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
      raw: null,
    },
    token: null,
  });

type LegacyPlainCredentialRead = Readonly<{
  revisionSemantics: 'revisioned';
  credentialRevision: string;
  content: Readonly<{
    t: 'plain';
    v: ConnectedServiceCredentialRecordV1;
  }>;
}>;

type LegacyProfileList = Readonly<{
  serviceId: BuiltInLegacyConnectedServiceId;
  profiles: readonly Readonly<{
    profileId: string;
    status:
      | 'connected'
      | 'refreshing'
      | 'needs_reauth'
      | 'refresh_failed_retryable';
    kind?: 'oauth' | 'token' | null;
  }>[];
}>;

function createLegacyApi() {
  return {
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    getServerFeaturesSnapshot: vi.fn(async () => undefined),
    getConnectedServiceCredentialPlain: vi.fn(async (): Promise<
      LegacyPlainCredentialRead
    > => ({
      revisionSemantics: 'revisioned' as const,
      credentialRevision,
      content: { t: 'plain' as const, v: legacyRecord },
    })),
    getConnectedServiceCredentialSealed: vi.fn(async () => null),
    registerConnectedServiceCredentialPlain: vi.fn(async () => ({
      success: true as const,
      credentialRevision,
    })),
    registerConnectedServiceCredentialSealed: vi.fn(async () => ({
      success: true as const,
      credentialRevision,
    })),
    listConnectedServiceProfiles: vi.fn(async (): Promise<
      LegacyProfileList
    > => ({
      serviceId: 'claude-subscription' as const,
      profiles: [{
        profileId: 'work',
        status: 'connected' as const,
        kind: 'token' as const,
      }],
    })),
  };
}

function createRevisionedPeerPersistence(legacyCredentialApi: ReturnType<
  typeof createLegacyApi
>) {
  return createQualifiedConnectedAccountDaemonPersistence({
    credentials: {
      token: 'token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(7),
      },
    },
    getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
    readCredential: vi.fn(async () => null),
    readConfiguration: vi.fn(async () => null),
    mutateCredential: vi.fn(),
    mutateConfiguration: vi.fn(),
    resolveServerFeaturesSnapshot: () => ({
      status: 'ready',
      features: revisionedPeerFeatures,
    }),
    legacyCredentialApi,
    secrets: {
      has: vi.fn(async () => false),
      read: vi.fn(async () => null),
    },
  });
}

describe('qualified Connected Account daemon old-peer compatibility', () => {
  it('projects a revisioned peer account without fabricating configuration readiness', async () => {
    const legacyCredentialApi = createLegacyApi();
    const persistence = createRevisionedPeerPersistence(legacyCredentialApi);

    await expect(
      persistence.profiles.list(claudeSubscriptionService),
    ).resolves.toEqual([
      expect.objectContaining({
        ref: {
          service: claudeSubscriptionService,
          accountId: 'work',
        },
        authenticationModeId: 'setup-token',
        configurationReady: false,
        configurationRevision: null,
      }),
    ]);
  });

  it('projects revisioned Gemini OAuth as needs_reauth without granting currentness authority', async () => {
    const legacyCredentialApi = createLegacyApi();
    legacyCredentialApi.listConnectedServiceProfiles.mockResolvedValue({
      serviceId: 'gemini',
      profiles: [{
        profileId: 'old-oauth',
        status: 'connected',
        kind: 'oauth',
      }],
    });
    legacyCredentialApi.getConnectedServiceCredentialPlain.mockResolvedValue({
      revisionSemantics: 'revisioned',
      credentialRevision,
      content: { t: 'plain', v: unsupportedGeminiOauthRecord },
    });
    const persistence = createRevisionedPeerPersistence(legacyCredentialApi);

    await expect(
      persistence.profiles.list({
        pluginId: 'happier.agent.gemini',
        localId: 'gemini-account',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        ref: {
          service: {
            pluginId: 'happier.agent.gemini',
            localId: 'gemini-account',
          },
          accountId: 'old-oauth',
        },
        status: 'needs_reauth',
        authenticationModeId: null,
        kind: 'oauth',
        configurationReady: false,
      }),
    ]);

    await expect(
      persistence.attempts.accounts.readExact({
        service: {
          pluginId: 'happier.agent.gemini',
          localId: 'gemini-account',
        },
        accountId: 'old-oauth',
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(
      legacyCredentialApi.getConnectedServiceCredentialPlain,
    ).toHaveBeenCalledTimes(1);
  });

  it('keeps exact unfenced passive reads on the legacy seam without fabricating qualified revisions', async () => {
    const legacyCredentialApi = createLegacyApi();
    const persistence = createQualifiedConnectedAccountDaemonPersistence({
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      readCredential: vi.fn(async () => null),
      readConfiguration: vi.fn(async () => null),
      mutateCredential: vi.fn(),
      mutateConfiguration: vi.fn(),
      resolveServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: exactPeerFeatures,
      }),
      resolveSessionSyncPendingInputServerContractResult: () => ({
        mode: 'released_server_v0_2_1',
        sessionConnectionEpoch: 4,
        socket: { connected: true },
      }),
      legacyCredentialApi,
      secrets: {
        has: vi.fn(async () => false),
        read: vi.fn(async () => null),
      },
    });

    await expect(
      persistence.profiles.list(claudeSubscriptionService),
    ).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    await expect(
      persistence.attempts.accounts.readExact({
        service: claudeSubscriptionService,
        accountId: 'work',
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_legacy_operation_unsupported',
    });
    expect(legacyCredentialApi.listConnectedServiceProfiles)
      .not.toHaveBeenCalled();
    expect(legacyCredentialApi.getConnectedServiceCredentialPlain)
      .not.toHaveBeenCalled();
  });
});
