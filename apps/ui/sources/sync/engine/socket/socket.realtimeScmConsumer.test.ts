import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/runtime/syncTuning', () => ({
  loadSyncTuning: () => ({
    sessionSocketApplyCoalescingEnabled: false,
    sessionSocketApplyCoalescingWindowMs: 0,
    sessionSocketApplyCoalescingMaxBatchSize: 64,
    sessionRealtimeProjectionMode: 'enabled',
  }),
}));

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { ScmWorkingSnapshot, Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { storage } from '@/sync/domains/state/storage';
import { resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getInitialState();
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];

function buildSession(params: Readonly<{
  id: string;
  path: string;
  machineId: string;
}>): Session {
  return {
    id: params.id,
    seq: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    active: true,
    activeAt: 1_000,
    metadata: {
      path: params.path,
      machineId: params.machineId,
    } as Session['metadata'],
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 'online',
    optimisticThinkingAt: null,
    encryptionMode: 'plain',
    latestTurnStatus: 'in_progress',
    latestTurnStatusObservedAt: 900,
  };
}

function buildRepoSnapshot(rootPath: string): ScmWorkingSnapshot {
  return {
    projectKey: `machine-a:${rootPath}`,
    fetchedAt: 1_500,
    repo: { isRepo: true, rootPath, backendId: 'git', mode: '.git' },
    capabilities: {
      readStatus: true,
      readDiffFile: true,
      readDiffCommit: true,
      readLog: true,
      writeInclude: true,
      writeExclude: true,
      writeCommit: true,
      writeBackout: true,
      writeRemoteFetch: true,
      writeRemotePull: true,
      writeRemotePush: true,
      worktreeCreate: true,
    },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0,
    hasConflicts: false,
    entries: [],
    totals: {
      includedFiles: 0,
      pendingFiles: 0,
      untrackedFiles: 0,
      includedAdded: 0,
      includedRemoved: 0,
      pendingAdded: 0,
      pendingRemoved: 0,
    },
  };
}

function buildPlainNewMessageUpdate(sessionId: string): ApiUpdateContainer {
  return {
    id: 'update-scm-message',
    seq: 2,
    createdAt: 2_000,
    body: {
      t: 'new-message',
      sid: sessionId,
      message: {
        id: 'message-scm',
        seq: 2,
        localId: null,
        createdAt: 2_000,
        updatedAt: 2_000,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              provider: 'codex',
              data: { type: 'message', message: 'scm mutation output' },
            },
          },
        },
      },
    },
  } satisfies ApiUpdateContainer;
}

function buildBaseParams(overrides: Partial<Omit<HandleUpdateContainerParams, 'updateData'>> = {}) {
  return {
    encryption: {
      getSessionEncryption: () => null,
      getMachineEncryption: () => null,
      removeSessionEncryption: () => {},
      decryptEncryptionKey: vi.fn(async () => null as Uint8Array | null),
      initializeMachines: vi.fn(async () => {}),
    } as unknown as HandleUpdateContainerParams['encryption'],
    artifactDataKeys: new Map<string, Uint8Array>(),
    applySessions: vi.fn((sessions: Parameters<HandleUpdateContainerParams['applySessions']>[0]) => {
      const normalizedSessions: Session[] = sessions.map((session) => ({
        ...session,
        presence: session.presence ?? 'online',
      }));
      storage.getState().applySessions(normalizedSessions);
    }),
    fetchSessions: vi.fn(),
    applyMessages: vi.fn(),
    onSessionVisible: vi.fn(),
    isSessionMessagesLoaded: vi.fn(() => true),
    getSessionMaterializedMaxSeq: vi.fn(() => 1),
    markSessionMaterializedMaxSeq: vi.fn(),
    onMessageGapDetected: vi.fn(),
    markSessionKnownRemoteSeq: vi.fn(),
    markSessionTranscriptDeferred: vi.fn(),
    markSessionTranscriptStale: vi.fn(),
    assumeUsers: vi.fn(async () => {}),
    applyTodoSocketUpdates: vi.fn(async () => {}),
    invalidateMachines: vi.fn(),
    invalidateSessions: vi.fn(),
    invalidateArtifacts: vi.fn(),
    invalidateFriends: vi.fn(),
    invalidateFriendRequests: vi.fn(),
    invalidateFeed: vi.fn(),
    invalidateAutomations: vi.fn(),
    invalidateTodos: vi.fn(),
    log: { log: vi.fn() },
    ...overrides,
  };
}

describe('socket realtime SCM transcript consumers', () => {
  let unregisterScmConsumer: (() => void) | null = null;

  beforeEach(() => {
    unregisterScmConsumer?.();
    unregisterScmConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  afterEach(() => {
    unregisterScmConsumer?.();
    unregisterScmConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  it('materializes hidden durable messages when an SCM consumer is mounted for the same project scope', async () => {
    const hiddenSessionId = 'hidden-scm-producer';
    const scmConsumerSessionId = 'visible-scm-consumer';
    storage.getState().applySessions([
      buildSession({ id: hiddenSessionId, machineId: 'machine-a', path: '/repo/packages/app' }),
      buildSession({ id: scmConsumerSessionId, machineId: 'machine-a', path: '/repo/packages/ui' }),
    ]);
    const snapshot = buildRepoSnapshot('/repo');
    storage.getState().updateSessionProjectScmSnapshot(scmConsumerSessionId, snapshot);
    const mountedScope = buildSessionRealtimeScmScopeFromSnapshot(
      storage.getState(),
      scmConsumerSessionId,
      snapshot,
    );
    expect(mountedScope).not.toBeNull();
    if (!mountedScope) throw new Error('Expected mounted SCM scope fixture');
    unregisterScmConsumer = registerSessionRealtimeScmConsumerScope(mountedScope);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({
        applyMessages,
        markSessionTranscriptDeferred,
      }),
      updateData: buildPlainNewMessageUpdate(hiddenSessionId),
    });

    expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
    expect(applyMessages).toHaveBeenCalledTimes(1);
    const [appliedSessionId, messages] = applyMessages.mock.calls[0] as [string, NormalizedMessage[]];
    expect(appliedSessionId).toBe(hiddenSessionId);
    expect(messages[0]).toMatchObject({
      id: 'message-scm',
      seq: 2,
      role: 'agent',
      content: [{ type: 'text', text: 'scm mutation output' }],
    });
  });
});
