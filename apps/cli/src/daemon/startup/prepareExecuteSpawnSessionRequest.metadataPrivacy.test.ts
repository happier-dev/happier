import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  type AccountEncryptionCurrentnessResponse,
  type SessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

const mocks = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  ensureSessionDirectory: vi.fn(async () => ({
    ok: true as const,
    directoryCreated: false,
  })),
  prepareDaemonSpawnChildEnvironment: vi.fn(),
  routeSpawnModeAndWaitForWebhook: vi.fn(),
  resolveCurrentExternalSessionAgentIdentity: vi.fn(async () => ({
    identity: {
      pluginId: 'happier.agent.codex',
      localId: 'codex',
    },
    sourceKinds: ['codexHome'],
  })),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: mocks.fetchSessionByIdCompat,
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: mocks.fetchAccountEncryptionCurrentness,
}));

vi.mock('./ensureSessionDirectory', () => ({
  ensureSessionDirectory: mocks.ensureSessionDirectory,
}));

vi.mock('../spawn/prepareDaemonSpawnChildEnvironment', () => ({
  prepareDaemonSpawnChildEnvironment: mocks.prepareDaemonSpawnChildEnvironment,
}));

vi.mock('../spawn/routeSpawnModeAndWaitForWebhook', () => ({
  routeSpawnModeAndWaitForWebhook: mocks.routeSpawnModeAndWaitForWebhook,
}));

vi.mock('@/api/session/external/linking/qualifiedLinkIdentityRegistry', () => ({
  resolveCurrentExternalSessionAgentIdentity:
    mocks.resolveCurrentExternalSessionAgentIdentity,
}));

vi.mock('@/session/runtime/catalogHooks', () => ({
  getVendorResumeSupport: vi.fn(async () => () => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';

const credentials = {
  token: 'token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array(32).fill(9),
  },
} satisfies Credentials;

const accountCryptoMaterial = createAccountScopedCryptoMaterialSnapshotV1({
  accountEncryptionMode: 'e2ee',
  material: {
    type: 'legacy',
    secret: credentials.encryption.secret,
  },
});

const e2eeAccountEncryptionCurrentness = {
  mode: 'e2ee',
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: accountCryptoMaterial.contentPublicKeyFingerprint,
  updatedAt: 1,
} satisfies AccountEncryptionCurrentnessResponse;

function buildSplitSession(
  ownerMetadata: SessionOwnerMetadataEnvelopeV1 | null,
) {
  return {
    id: 'session-private-resume',
    seq: 4,
    encryptionMode: 'plain',
    metadataLayoutVersion: 1,
    metadataVersion: 3,
    metadata: JSON.stringify({
      v: 1,
      summary: { text: 'Safe title', updatedAt: 10 },
      agentPresentation: { agentId: 'claude' },
    }),
    ownerMetadata,
    agentStateVersion: 2,
    agentState: JSON.stringify({}),
    dataEncryptionKey: null,
  };
}

describe('prepareExecuteSpawnSessionRequest metadata privacy authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue(
      e2eeAccountEncryptionCurrentness,
    );
  });

  it.each([
    ['missing', null],
    ['malformed', {
      t: 'encrypted',
      c: 'not-an-account-owner-envelope',
    } as const],
  ] as const)(
    'fails typed before directory or handoff work when owner metadata is %s',
    async (_caseName, ownerMetadata) => {
      mocks.fetchSessionByIdCompat.mockResolvedValueOnce(
        buildSplitSession(ownerMetadata),
      );
      const loadLocalHandoffMetadataByVendorResumeId = vi.fn(async () => null);

      const result = await prepareExecuteSpawnSessionRequest({
        request: {
          options: {
            directory: '/shared-fallback-must-not-run',
            existingSessionId: 'session-private-resume',
          },
          credentials,
          loadLocalHandoffMetadataByVendorResumeId,
        },
        validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
      });

      expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
      expect(loadLocalHandoffMetadataByVendorResumeId).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: 'Owner session metadata is unavailable for resume.',
      });
    },
  );

  it('derives workspace, Agent, and vendor resume authority only from the owner envelope', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/worktree',
        machineId: 'private-machine',
      },
      nativeSession: {
        codexSessionId: 'private-vendor-resume',
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'private-machine',
          remoteSessionId: 'private-vendor-resume',
          source: { kind: 'codexHome', home: 'user' },
          qualifiedIdentity: {
            v: 1,
            agent: {
              pluginId: 'happier.agent.codex',
              localId: 'codex',
            },
            source: {
              kind: 'codexHome',
              contractVersion: 1,
            },
          },
          linkedAtMs: 1,
        },
      },
    });
    const ownerEnvelope = sealSessionOwnerMetadataEnvelopeV1({
      material: {
        type: 'legacy',
        secret: credentials.encryption.secret,
      },
      ownerMetadata,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    mocks.fetchSessionByIdCompat.mockResolvedValueOnce(
      buildSplitSession(ownerEnvelope),
    );

    const result = await prepareExecuteSpawnSessionRequest({
      request: {
        options: {
          directory: '/shared-fallback-must-not-win',
          existingSessionId: 'session-private-resume',
        },
        credentials,
        loadLocalHandoffMetadataByVendorResumeId: async () => null,
      },
      validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });

    expect(result).toMatchObject({
      directory: '/private/worktree',
      normalizedExistingSessionId: 'session-private-resume',
      effectiveResume: 'private-vendor-resume',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      catalogAgentId: 'codex',
    });
    expect(mocks.ensureSessionDirectory).toHaveBeenCalledWith({
      directory: '/private/worktree',
      approvedNewDirectoryCreation: true,
    });
    expect(result).toMatchObject({
      sessionAttachPayload: {
        snapshot: {
          metadata: {
            agentPresentation: { agentId: 'claude' },
          },
          ownerMetadata: {
            nativeSession: {
              codexSessionId: 'private-vendor-resume',
              externalSessionV1: {
                qualifiedIdentity: {
                  agent: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                  },
                  source: {
                    kind: 'codexHome',
                    contractVersion: 1,
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('/shared-fallback-must-not-win');
  });

  it('keeps process launch and first-prompt materialization unreachable on owner-envelope failure', async () => {
    mocks.fetchSessionByIdCompat.mockResolvedValueOnce(
      buildSplitSession(null),
    );
    const loadLocalHandoffMetadataByVendorResumeId = vi.fn(async () => null);

    const result = await executeSpawnSessionRequest({
      options: {
        directory: '/shared-fallback-must-not-run',
        existingSessionId: 'session-private-resume',
        pendingFirstInput: {
          text: 'private prompt must remain untouched',
          localId: 'private-prompt-1',
        },
      },
      credentials,
      api: {},
      loadLocalHandoffMetadataByVendorResumeId,
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      connectedServiceRefreshCoordinator: null,
      connectedServiceQuotasCoordinator: null,
      connectedServiceRuntimeRegistry: { registerTarget: vi.fn() },
      pidToTrackedSession: new Map(),
      pidToAwaiter: new Map(),
      pidToSpawnResultResolver: new Map(),
      pidToSpawnWebhookTimeout: new Map(),
      resolveCanonicalTrackedSessionId: vi.fn(() => 'never'),
      onChildExited: vi.fn(),
      spawnResourceCleanupByPid: new Map(),
      sessionAttachCleanupByPid: new Map(),
      processEnv: {},
    } as never);

    expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
    expect(loadLocalHandoffMetadataByVendorResumeId).not.toHaveBeenCalled();
    expect(mocks.prepareDaemonSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(mocks.routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Owner session metadata is unavailable for resume.',
    });
  });
});
