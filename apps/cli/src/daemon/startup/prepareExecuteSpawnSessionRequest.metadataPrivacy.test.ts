import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
  SessionCreationTagV1Schema,
  type AccountEncryptionCurrentnessResponse,
  type SessionOwnerMetadataEnvelopeV1,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { configuration } from '@/configuration';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

const mocks = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  ensureSessionDirectory: vi.fn(async () => ({
    ok: true as const,
    directoryCreated: false,
  })),
  prepareDaemonSpawnChildEnvironment: vi.fn(),
  routeSpawnModeAndWaitForWebhook: vi.fn(),
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

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    infoFile: vi.fn(),
    warn: vi.fn(),
  },
}));

import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';

let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({
    happyHomeDir: configuration.happyHomeDir,
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] },
  });
});
afterAll(async () => {
  try { await runtime?.dispose(); }
  finally { await pluginReloadController.shutdown(); }
});

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
  recipientEnvelopeReadiness: { status: 'available' },
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
  it('retains trusted managed creation routing before the new child has published its directory marker', async () => {
    const sessionCreationTag = SessionCreationTagV1Schema.parse(`create:v1:${'a'.repeat(43)}`);
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1, workspace: { path: '/private/chat', machineId: 'machine-1' },
      nativeSession: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValueOnce(buildSplitSession(sealSessionOwnerMetadataEnvelopeV1({
      material: credentials.encryption, ownerMetadata, randomBytes: (length) => new Uint8Array(length).fill(7),
    })));
    const result = await prepareExecuteSpawnSessionRequest({
      request: {
        options: {
          existingSessionId: 'session-private-resume', directory: '/private/chat',
          directoryKind: 'managed', freshSessionCreation: true, sessionCreationTag,
        },
        credentials,
      },
      validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });
    expect(result).toMatchObject({ directory: '/private/chat', directoryKind: 'managed', sessionCreationTag });
  });

  it('routes a managed existing session from owner metadata rather than a caller path classification', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: { path: '/private/chat', machineId: 'machine-1', sessionDirectoryV1: { v: 1, kind: 'managed' } },
      nativeSession: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValueOnce(buildSplitSession(sealSessionOwnerMetadataEnvelopeV1({
      material: credentials.encryption, ownerMetadata, randomBytes: (length) => new Uint8Array(length).fill(7),
    })));
    const result = await prepareExecuteSpawnSessionRequest({
      request: { options: { existingSessionId: 'session-private-resume', directory: '/untrusted', directoryKind: 'path' }, credentials },
      validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });
    expect(result).toMatchObject({ directory: '/private/chat', directoryKind: 'managed' });
  });

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
      const result = await prepareExecuteSpawnSessionRequest({
        request: {
          options: {
            directory: '/shared-fallback-must-not-run',
            existingSessionId: 'session-private-resume',
          },
          credentials,
        },
        validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
      });

      expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
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
        sessionDirectoryV1: { v: 1, kind: 'managed' },
      },
      nativeSession: {
        codexSessionId: 'private-vendor-resume',
        runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
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
          runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } },
        },
        credentials,
      },
      validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });

    expect(result).toMatchObject({
      directory: '/private/worktree',
      directoryKind: 'managed',
      normalizedExistingSessionId: 'session-private-resume',
      effectiveResume: 'private-vendor-resume',
      effectiveBackendTargetV2: {
        kind: 'backend',
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      catalogAgentId: 'codex',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
    });
    // Preparation resolves the owner-derived workspace but performs no
    // filesystem work: creation belongs after the definitive refusals.
    expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
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
      connectedServicesMaterializationBaseDir: '/tmp/connected-services',
      connectedServiceRefreshCoordinator: null,
      connectedServiceQuotasCoordinator: null,
      connectedServiceRuntimeRegistry: { registerTarget: vi.fn() },
      trackedSessionsByKey: new Map(),
      spawnAwaiterByKey: new Map(),
      spawnResultResolverByKey: new Map(),
      spawnWebhookTimeoutByKey: new Map(),
      resolveCanonicalTrackedSessionId: vi.fn(() => 'never'),
      onChildExited: vi.fn(),
      spawnResourceCleanupByKey: new Map(),
      sessionAttachCleanupByKey: new Map(),
      processEnv: {},
    } as never);

    expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
    expect(mocks.prepareDaemonSpawnChildEnvironment).not.toHaveBeenCalled();
    expect(mocks.routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'Owner session metadata is unavailable for resume.',
    });
  });
});
