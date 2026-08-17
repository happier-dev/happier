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
import { storage } from '@/sync/domains/state/storage';
import { resetSessionSurfaceVisibilityForTests } from '@/sync/domains/session/sessionSurfaceVisibility';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import {
  buildSessionRealtimeScmScopeFromSnapshot,
  registerSessionRealtimeScmConsumerScope,
} from '@/sync/runtime/sessionRealtimeScmConsumers';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { handleEphemeralSocketUpdate, handleUpdateContainer } from './socket';

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

function buildPlainEditToolNewMessageUpdate(sessionId: string, filePath: string): ApiUpdateContainer {
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
        messageRole: 'agent',
        createdAt: 2_000,
        updatedAt: 2_000,
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'output',
              data: {
                type: 'assistant',
                uuid: 'uuid-edit',
                message: {
                  role: 'assistant',
                  content: [
                    {
                      type: 'tool_use',
                      id: 'toolu_edit_1',
                      name: 'Edit',
                      input: { file_path: filePath, old_string: 'a', new_string: 'b' },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    },
  } satisfies ApiUpdateContainer;
}

function buildTranscriptStreamSegmentUpdate(sessionId: string, localId: string) {
  return {
    type: 'transcript-stream-segment',
    sessionId,
    message: {
      localId,
      content: {
        t: 'plain',
        v: {
          role: 'agent',
          content: {
            type: 'acp',
            agentId: 'codex',
            data: { type: 'message', message: 'streaming segment text' },
          },
        },
      },
      messageRole: 'agent',
      createdAt: 2_100,
      updatedAt: 2_100,
    },
  };
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
    artifactDataKeys: new Map(),
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

function mountRepoScmConsumerScope(scmConsumerSessionId: string, repoRoot: string): () => void {
  const snapshot = buildRepoSnapshot(repoRoot);
  storage.getState().updateSessionProjectScmSnapshot(scmConsumerSessionId, snapshot);
  const mountedScope = buildSessionRealtimeScmScopeFromSnapshot(
    storage.getState(),
    scmConsumerSessionId,
    snapshot,
  );
  if (!mountedScope) throw new Error('Expected mounted SCM scope fixture');
  return registerSessionRealtimeScmConsumerScope(mountedScope);
}

describe('socket realtime SCM transcript consumers', () => {
  let unregisterScmConsumer: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    unregisterScmConsumer?.();
    unregisterScmConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    unregisterScmConsumer?.();
    unregisterScmConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  it('keeps hidden same-project durable messages projection-only while delivering the SCM mutation signal', async () => {
    const hiddenSessionId = 'hidden-scm-producer';
    const scmConsumerSessionId = 'visible-scm-consumer';
    storage.getState().applySessions([
      buildSession({ id: hiddenSessionId, machineId: 'machine-a', path: '/repo/packages/app' }),
      buildSession({ id: scmConsumerSessionId, machineId: 'machine-a', path: '/repo/packages/ui' }),
    ]);
    unregisterScmConsumer = mountRepoScmConsumerScope(scmConsumerSessionId, '/repo');

    // scmStatusSync executes daemon RPC snapshot fetches (system boundary); stub the refresh
    // executor and assert the outcome call into the canonical refresh owner instead.
    const invalidateFromMutation = vi.spyOn(scmStatusSync, 'invalidateFromMutation').mockImplementation(() => {});
    const invalidateFromAutoRefresh = vi.spyOn(scmStatusSync, 'invalidateFromAutoRefresh').mockImplementation(() => {});

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({
        applyMessages,
        markSessionTranscriptDeferred,
      }),
      updateData: buildPlainEditToolNewMessageUpdate(hiddenSessionId, '/repo/packages/app/src/index.ts'),
    });

    // Hidden session stays on the projection-only route: no transcript materialization.
    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledWith(hiddenSessionId, expect.objectContaining({
      updateType: 'new-message',
      seq: 2,
    }));

    // The side channel feeds the existing debounced workspace-mutation ingestion.
    await vi.advanceTimersByTimeAsync(300);
    expect(invalidateFromMutation).toHaveBeenCalledWith(hiddenSessionId);
    expect(invalidateFromAutoRefresh).not.toHaveBeenCalled();
    expect(storage.getState().sessionMessages[hiddenSessionId]).toBeUndefined();
  });

  it('does not deliver the SCM mutation signal for hidden sessions outside the mounted project scope', async () => {
    const unrelatedSessionId = 'hidden-unrelated-producer';
    const scmConsumerSessionId = 'visible-scm-consumer';
    storage.getState().applySessions([
      buildSession({ id: unrelatedSessionId, machineId: 'machine-a', path: '/elsewhere/app' }),
      buildSession({ id: scmConsumerSessionId, machineId: 'machine-a', path: '/repo/packages/ui' }),
    ]);
    unregisterScmConsumer = mountRepoScmConsumerScope(scmConsumerSessionId, '/repo');

    const invalidateFromMutation = vi.spyOn(scmStatusSync, 'invalidateFromMutation').mockImplementation(() => {});
    const invalidateFromAutoRefresh = vi.spyOn(scmStatusSync, 'invalidateFromAutoRefresh').mockImplementation(() => {});

    const applyMessages = vi.fn();
    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages }),
      updateData: buildPlainEditToolNewMessageUpdate(unrelatedSessionId, '/elsewhere/app/src/index.ts'),
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(applyMessages).not.toHaveBeenCalled();
    expect(invalidateFromMutation).not.toHaveBeenCalled();
    expect(invalidateFromAutoRefresh).not.toHaveBeenCalled();
  });

  it('drops hidden same-project ephemeral stream segments without decrypting or applying', async () => {
    const hiddenSessionId = 'hidden-scm-producer';
    const scmConsumerSessionId = 'visible-scm-consumer';
    storage.getState().applySessions([
      buildSession({ id: hiddenSessionId, machineId: 'machine-a', path: '/repo/packages/app' }),
      buildSession({ id: scmConsumerSessionId, machineId: 'machine-a', path: '/repo/packages/ui' }),
    ]);
    unregisterScmConsumer = mountRepoScmConsumerScope(scmConsumerSessionId, '/repo');

    const applyMessages = vi.fn();
    const getSession = vi.fn((sessionId: string) => storage.getState().sessions[sessionId]);
    const getSessionEncryption = vi.fn(() => null);
    const buildEphemeralParams = () => ({
      addActivityUpdate: vi.fn(),
      addMachineActivityUpdate: vi.fn(),
      getSessionEncryption,
      getSession,
      applyMessages,
    });

    // Hidden same-project session: the 25Hz segment hits the drop path before any
    // session/decrypt/normalize work.
    await handleEphemeralSocketUpdate({
      update: buildTranscriptStreamSegmentUpdate(hiddenSessionId, 'segment-hidden'),
      ...buildEphemeralParams(),
    });
    expect(applyMessages).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(getSessionEncryption).not.toHaveBeenCalled();

    // Control: the mounted SCM consumer session itself stays a live consumer, proving the
    // fixture is well-formed and only the hidden fan-out was removed.
    await handleEphemeralSocketUpdate({
      update: buildTranscriptStreamSegmentUpdate(scmConsumerSessionId, 'segment-visible'),
      ...buildEphemeralParams(),
    });
    expect(applyMessages).toHaveBeenCalledTimes(1);
    expect(applyMessages.mock.calls[0]?.[0]).toBe(scmConsumerSessionId);
  });
});
