import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ForkBackendResolution, ForkSpawnSession } from './forkLifecycleTypes';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import type { ForkSurfaceV1 } from '@happier-dev/agents';

const getForkSurfaceMock = vi.fn();
const createReplaySeededSessionMock = vi.fn();
const resolveReplaySeedDraftMock = vi.fn();

vi.mock('@/backends/catalog', () => ({
  getForkSurface: (...args: unknown[]) => getForkSurfaceMock(...args),
}));

vi.mock('@/session/replay/createReplaySeededSession', () => ({
  createReplaySeededSession: (...args: unknown[]) => createReplaySeededSessionMock(...args),
}));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: (...args: unknown[]) => resolveReplaySeedDraftMock(...args),
}));

import { createReplayForkSession } from './createReplayForkSession';

const CONNECTED_SERVICES = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
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
    providerAgentId: 'codex',
    providerHintProviderId: 'codex',
    backendTargetV2: {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    },
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    replayFlavor: 'codex',
    metadataOverlay: {},
    configuredAcp: null,
  };
}

describe('createReplayForkSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createReplaySeededSessionMock.mockResolvedValue({ sessionId: 'child-session' });
    resolveReplaySeedDraftMock.mockResolvedValue({
      seedDraft: 'Replay this conversation',
      dialog: [],
      summaryText: null,
      sourceCutoffSeqInclusive: 3,
      referencedSessionMediaWorkspacePaths: [],
    });
  });

  it('uses provider replay child launch directory hints for spawning', async () => {
    const resolveReplayChildLaunch = vi.fn().mockResolvedValue({
        directory: '/tmp/provider-child-worktree',
        environmentVariables: { PROVIDER_CHILD: '1' },
    });
    getForkSurfaceMock.mockResolvedValue(null);
    createReplaySeededSessionMock.mockResolvedValueOnce({ sessionId: 'child-session' });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-session' });

    const input = {
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
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
    expect(getForkSurfaceMock).not.toHaveBeenCalled();
    expect(resolveReplayChildLaunch).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/parent-worktree',
      forkPoint: { kind: 'latest' },
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/provider-child-worktree',
      environmentVariables: { PROVIDER_CHILD: '1' },
    }));
    expect(createReplaySeededSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/provider-child-worktree',
    }));
  });

  it('creates replay child metadata and spawn options with a fresh connected-service identity', async () => {
    const createdMetadata: Record<string, unknown>[] = [];
    createReplaySeededSessionMock.mockImplementationOnce(async (input: { metadata: Record<string, unknown> }) => {
      createdMetadata.push(input.metadata);
      return { sessionId: 'child-session' };
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

  it('does not add a connected-service identity to replay children without connected services', async () => {
    const createdMetadata: Record<string, unknown>[] = [];
    createReplaySeededSessionMock.mockImplementationOnce(async (input: { metadata: Record<string, unknown> }) => {
      createdMetadata.push(input.metadata);
      return { sessionId: 'child-session' };
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
});
