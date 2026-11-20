import { createServer } from 'node:http';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ForkBackendResolution, ForkSpawnSession } from './forkLifecycleTypes';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { withCliApiToken } from '@/auth/cliApiToken';
import { createForkSessionLifecycleActionHandler } from '../createForkSessionLifecycleActionHandler';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ForkSurfaceV1 } from '@happier-dev/agents';
import { deriveSessionCreationTagV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';

const getOrCreateSessionByTagMock = vi.fn();
const fetchSessionByIdCompatMock = vi.fn();
const resolveReplaySeedDraftMock = vi.fn();
const archiveSessionOnceInactiveMock = vi.fn();
const fetchSessionOrganizationPlacementMock = vi.fn();
const validateStoredAuthTokenAgainstActiveServerMock = vi.fn();
const fetchAccountEncryptionCurrentnessMock = vi.fn();
const sendSessionMessageMock = vi.fn();

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => resolveReplaySeedDraftMock(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  getOrCreateSessionByTag: (...args: unknown[]) => getOrCreateSessionByTagMock(...args),
  fetchSessionByIdCompat: (...args: unknown[]) => fetchSessionByIdCompatMock(...args),
  fetchSessionOrganizationPlacement: (...args: unknown[]) => fetchSessionOrganizationPlacementMock(...args),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (...args: unknown[]) =>
    validateStoredAuthTokenAgainstActiveServerMock(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) => fetchAccountEncryptionCurrentnessMock(...args),
}));

vi.mock('@/session/services/archiveSessionOnceInactive', () => ({
  archiveSessionOnceInactive: (...args: unknown[]) => archiveSessionOnceInactiveMock(...args),
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage: (...args: unknown[]) => sendSessionMessageMock(...args),
}));

import { createReplayForkSession } from './createReplayForkSession';

const CONNECTED_SERVICES = {
  v: 2,
  bindingsByServiceId: {
    'happier.agent.codex/openai-codex': {
      source: 'connected',
      selection: 'profile',
      profileId: 'codex-work',
    },
  },
} as const;

const PARENT_MATERIALIZATION_IDENTITY = {
  v: 1,
  id: 'csm_parent_replay_identity',
  createdAt: 100,
  source: 'first_spawn',
} as const;

function createBuiltInForkResolution(): ForkBackendResolution {
  return {
    ok: true,
    catalogAgentId: 'codex',
    agentHintAgentId: 'codex',
    backendTargetV2: {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    },
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    replayFlavor: 'codex',
    metadataOverlay: {},
  };
}

async function withReplayHome<T>(machineId: string, run: () => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    let body: object;
    if (request.method === 'GET' && request.url === `/v1/access-keys/child-session/${machineId}`) {
      body = { accessKey: 'fixture-key' };
    } else if (request.method === 'POST' && request.url === '/v2/sessions/lookup-by-tags') {
      body = { sessions: [] };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback listener');
    return await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, run);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('createReplayForkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateSessionByTagMock.mockResolvedValue({ session: { id: 'child-session' }, created: true });
    resolveReplaySeedDraftMock.mockResolvedValue({
      status: 'seeded',
      seedDraft: 'Replay this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 3,
      referencedSessionMediaWorkspacePaths: [],
    });
    fetchSessionOrganizationPlacementMock.mockResolvedValue({ folderId: null, tagIds: [] });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid' });
    fetchAccountEncryptionCurrentnessMock.mockResolvedValue({ mode: 'plain', version: 1 });
    archiveSessionOnceInactiveMock.mockResolvedValue({ archivedAt: 1 });
  });

  it('uses provider replay child launch directory hints for spawning', async () => {
    const resolveReplayChildLaunch = vi.fn().mockResolvedValue({
        directory: '/tmp/provider-child-worktree',
        environmentVariables: { PROVIDER_CHILD: '1' },
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        model: 'fast',
        externalSessionOperation: { operationClaimId: 'legacy-private-claim' },
        externalSessionOperationV1: {
          v: 1,
          progress: { operationId: 'private-operation', revision: 4 },
        },
        externalSessionOperationPresentationV1: {
          v: 1,
          operationId: 'private-operation',
          revision: 4,
          kind: 'materialize',
          status: 'running',
          phase: 'publishing',
        },
        compatibilityMetadata: { owner: 'private' },
        ownerProjection: { owner: 'private' },
        operationClaimId: 'claim-private',
        fence: { token: 'private' },
        paths: { staging: '/private/staging' },
        host: { pid: 123 },
        runtime: { custody: 'private' },
        custody: { generation: 'private' },
      },
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'nonce-1',
      forkPointType: 'latest' as const,
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { resolveReplayChildLaunch } satisfies ForkSurfaceV1,
      spawnSession,
    };
    const result = await createReplayForkSession(input);

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(resolveReplayChildLaunch).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: {
      },
      directory: '/tmp/parent-worktree',
      forkPoint: { kind: 'latest' },
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/provider-child-worktree',
      environmentVariables: { PROVIDER_CHILD: '1' },
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'child-session',
    }));
  });

  it('fails closed before creating a replay child when launch hints contain owner-private Session state', async () => {
    const resolveReplayChildLaunch = vi.fn().mockResolvedValue({
      sessionStateUpdates: [{
        fieldId: 'runtime.externalSessionOperation',
        value: 'private-operation',
      }],
    });
    const spawnSession = vi.fn<ForkSpawnSession>();

    await expect(createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'private-state-replay',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: { metadata: {}, spawn: {} },
      forkSurface: { resolveReplayChildLaunch } as ForkSurfaceV1,
      spawnSession,
    })).rejects.toThrow(/unsupported field.*runtime\.externalSessionOperation/i);

    expect(resolveReplaySeedDraftMock).not.toHaveBeenCalled();
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('launches a replay fork in the same guest checkout and retains the address for the child', async () => {
    const inPlaceWorkspace = {
      v: 2, kind: 'managed', serverId: 'home', managedId: 'guest', workspaceId: 'workspace',
      controller: { machineId: 'controller', installationId: 'install' }, rootPath: '/guest/shared',
    } as const;
    const parentTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'test', creationKey: 'parent' });
    const spawnSession = vi.fn<ForkSpawnSession>().mockResolvedValue({ type: 'success', sessionId: 'child-session' });
    const resolveReplayChildLaunch = vi.fn().mockResolvedValue({ directory: '/controller/shared' });
    const result = await withReplayHome('controller', () => createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        machineId: 'controller',
        sessionDirectoryV1: { v: 1, kind: 'managed' },
        sessionCreationCorrespondenceV1: { v: 1, sessionCreationTag: parentTag, recipe: {
          execution: { machineId: 'controller', directory: { kind: 'managed' } },
          organization: { folderId: null, tagIds: [] },
          agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
          modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null,
          configuration: null, connectedServices: null, capabilitySelection: null, transcriptStorage: null,
          terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null, inPlaceWorkspace,
        } },
      },
      directory: '/guest/shared',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'fork-in-place',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: { metadata: {}, spawn: {} },
      forkSurface: { resolveReplayChildLaunch },
      spawnSession,
    }));

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(resolveReplayChildLaunch).not.toHaveBeenCalled();
    expect(spawnSession.mock.calls[0]?.[0]).toMatchObject({
      directoryKind: 'managed',
      managedTargetPlacement: { managedId: 'guest', workspaceRoot: '/guest/shared' },
      sessionCreationCorrespondence: { recipe: { inPlaceWorkspace } },
    });
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('managedDirectorySeed');
    const childTag = spawnSession.mock.calls[0]?.[0]?.sessionCreationTag;
    expect(childTag).not.toBe(parentTag);
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        sessionCreationCorrespondenceV1: expect.objectContaining({ sessionCreationTag: childTag, recipe: expect.objectContaining({ inPlaceWorkspace }) }),
      }),
    }));
  });

  it('refuses a legacy native fork for an in-place guest without invoking its provider hook', async () => {
    const inPlaceWorkspace = {
      v: 2, kind: 'managed', serverId: 'home', managedId: 'guest', workspaceId: 'workspace',
      controller: { machineId: 'controller', installationId: 'install' }, rootPath: '/guest/shared',
    } as const;
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'test', creationKey: 'parent' });
    fetchSessionByIdCompatMock.mockResolvedValueOnce({
      id: 'parent-session', seq: 3, encryptionMode: 'plain', metadata: JSON.stringify({
        flavor: 'gemini', path: '/guest/shared', machineId: 'controller',
        sessionDirectoryV1: { v: 1, kind: 'managed' },
        sessionCreationCorrespondenceV1: buildSessionCreationCorrespondence({
          identity: { sessionCreationTag },
          recipe: {
            execution: { machineId: 'controller', directory: { kind: 'managed' } },
            organization: { folderId: null, tagIds: [] },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } },
            inPlaceWorkspace,
          },
        }),
      }),
    });
    const providerFork = vi.fn<NonNullable<ForkSurfaceV1['fork']>>().mockResolvedValue(null);
    const spawnSession = vi.fn<ForkSpawnSession>();
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: getSessionHostBridge(),
      resolveExecutionSurfaces: async () => ({
        terminalRuntime: null, externalSession: null, attach: null, handoff: null,
        fork: { fork: providerFork }, checkpoint: null,
      }),
      handlers: { spawnSession, stopSession: async () => false },
    });
    const result = await withCliApiToken(`hap_v1_123e4567-e89b-42d3-a456-426614174000_${'A'.repeat(43)}`, () => handler({
      v: 1, parentSessionId: 'parent-session', forkPoint: { type: 'latest' }, strategy: 'native',
    }));
    expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
    expect(providerFork).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('uses the caller spawn nonce as the replay child tag', async () => {
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    const result = await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'fork:stable-nonce',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: null,
      spawnSession,
    });

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(getOrCreateSessionByTagMock).toHaveBeenCalledWith(expect.objectContaining({
      tag: 'fork:stable-nonce',
    }));
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      spawnNonce: 'fork:stable-nonce',
    }));
  });

  it('targets the parent session machine when replaying a provider-bound fork', async () => {
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    await withReplayHome('machine-a', () => createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: { machineId: 'machine-a' },
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'fork:provider-replay',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {
          modelSelection: {
            v: 1,
            updatedAt: 1,
            ref: {
              agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
              modelId: 'provider-model',
            },
          },
        },
      },
      forkSurface: null,
      spawnSession,
    }));

    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a' }));
  });

  it('does not archive the replay child when spawn times out waiting for webhook', async () => {
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Timed out waiting for session webhook',
      });

    const result = await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'fork:timeout-nonce',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: null,
      spawnSession,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(archiveSessionOnceInactiveMock).not.toHaveBeenCalled();
  });

  it('creates replay child metadata and spawn options with a fresh connected-service identity', async () => {
    const createdMetadata: Record<string, unknown>[] = [];
    getOrCreateSessionByTagMock.mockImplementationOnce(async (input: { metadata: Record<string, unknown> }) => {
      createdMetadata.push(input.metadata);
      return { session: { id: 'child-session' }, created: true };
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockImplementation(async (options) => {
        if (options.connectedServices && !options.connectedServiceMaterializationIdentityV1) {
          return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
            errorMessage: 'connected_service_materialization_identity_missing',
          };
        }
        return { type: 'success', sessionId: 'child-session' };
      });

    const result = await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'nonce-1',
      forkPointType: 'seq',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: { connectedServices: CONNECTED_SERVICES },
        spawn: { connectedServices: CONNECTED_SERVICES },
      },
      forkSurface: null,
      spawnSession,
    });

    const spawnOptions = spawnSession.mock.calls[0]?.[0];
    const spawnIdentity = spawnOptions?.connectedServiceMaterializationIdentityV1;
    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(spawnIdentity).toEqual(expect.objectContaining({
      v: 1,
      id: expect.stringMatching(/^csm_/),
    }));
    expect(spawnIdentity?.id).not.toBe(PARENT_MATERIALIZATION_IDENTITY.id);
    expect(createdMetadata[0]?.connectedServices).toEqual(CONNECTED_SERVICES);
    expect(createdMetadata[0]?.connectedServiceMaterializationIdentityV1).toEqual(spawnIdentity);
  });

  it('keeps a replay child identity stable on retry while minting a distinct identity for the next attempt', async () => {
    const rowsByTag = new Map<string, Readonly<{
      sessionId: string;
      metadata: Record<string, unknown>;
    }>>();
    let nextSession = 1;
    getOrCreateSessionByTagMock.mockImplementation(async (input: { tag: string; metadata: Record<string, unknown> }) => {
      const existing = rowsByTag.get(input.tag);
      if (existing) {
        return {
          created: false,
          session: {
            id: existing.sessionId,
            encryptionMode: 'plain',
            metadata: JSON.stringify(existing.metadata),
          },
        };
      }
      const row = {
        sessionId: `child-session-${nextSession++}`,
        metadata: input.metadata,
      };
      rowsByTag.set(input.tag, row);
      return { created: true, session: { id: row.sessionId } };
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockImplementation(async (options) => ({ type: 'success', sessionId: options.existingSessionId! }));

    const create = async (spawnNonce: string) => await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce,
      forkPointType: 'seq',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: { connectedServices: CONNECTED_SERVICES },
        spawn: { connectedServices: CONNECTED_SERVICES },
      },
      forkSurface: null,
      spawnSession,
    });

    await expect(create('fork:retry')).resolves.toEqual({ ok: true, childSessionId: 'child-session-1' });
    await expect(create('fork:retry')).resolves.toEqual({ ok: true, childSessionId: 'child-session-1' });
    await expect(create('fork:next-attempt')).resolves.toEqual({ ok: true, childSessionId: 'child-session-2' });

    const firstAttemptIdentity = spawnSession.mock.calls[0]?.[0].connectedServiceMaterializationIdentityV1;
    const retryIdentity = spawnSession.mock.calls[1]?.[0].connectedServiceMaterializationIdentityV1;
    const nextAttemptIdentity = spawnSession.mock.calls[2]?.[0].connectedServiceMaterializationIdentityV1;
    expect(firstAttemptIdentity).toEqual(expect.objectContaining({ v: 1, source: 'fork' }));
    expect(retryIdentity).toEqual(firstAttemptIdentity);
    expect(nextAttemptIdentity).toEqual(expect.objectContaining({ v: 1, source: 'fork' }));
    expect(nextAttemptIdentity).not.toEqual(firstAttemptIdentity);
    expect(rowsByTag.get('fork:retry')?.metadata.connectedServiceMaterializationIdentityV1).toEqual(firstAttemptIdentity);
    expect(rowsByTag.get('fork:next-attempt')?.metadata.connectedServiceMaterializationIdentityV1).toEqual(nextAttemptIdentity);
  });

  it('does not add a connected-service identity to replay children without connected services', async () => {
    const createdMetadata: Record<string, unknown>[] = [];
    getOrCreateSessionByTagMock.mockImplementationOnce(async (input: { metadata: Record<string, unknown> }) => {
      createdMetadata.push(input.metadata);
      return { session: { id: 'child-session' }, created: true };
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    const result = await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 3,
      spawnNonce: 'nonce-1',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: null,
      spawnSession,
    });

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    expect(spawnSession.mock.calls[0]?.[0]).not.toHaveProperty('connectedServiceMaterializationIdentityV1');
    expect(createdMetadata[0]).not.toHaveProperty('connectedServiceMaterializationIdentityV1');
  });

  it('bounds a `latest` fork seed by the cutoff the lifecycle already admitted', async () => {
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    const result = await createReplayForkSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/parent-worktree',
      effectiveCutoffSeqInclusive: 41,
      spawnNonce: 'latest-cutoff-bound',
      forkPointType: 'latest',
      replaySummaryRunner: null,
      replayMaxSeedChars: undefined,
      maxTextChars: undefined,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: { metadata: {}, spawn: {} },
      forkSurface: null,
      spawnSession,
    });

    expect(result).toEqual({ ok: true, childSessionId: 'child-session' });
    // Retrieval must not re-resolve "latest": a row committed after the
    // lifecycle admitted seq 41 would otherwise enter the child's seed while
    // its recorded lineage still names 41.
    expect(resolveReplaySeedDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        kind: 'fork_chain',
        previousSessionId: 'parent-session',
        upToSeqInclusive: 41,
      },
    }));
  });
});
