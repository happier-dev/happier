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
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { storage } from '@/sync/domains/state/storage';
import {
  markSessionSurfaceVisible,
  resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { handleUpdateContainer } from './socket';

const initialStorageState = storage.getInitialState();
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];

function buildSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    seq: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    active: true,
    activeAt: 1_000,
    metadata: null,
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
    ...overrides,
  };
}

function buildPlainNewMessageUpdate(sessionId: string): ApiUpdateContainer {
  return {
    id: 'update-transcript-consumer',
    seq: 2,
    createdAt: 2_000,
    body: {
      t: 'new-message',
      sid: sessionId,
      message: {
        id: 'message-transcript-consumer',
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
              data: { type: 'message', message: 'streaming detail pane output' },
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

describe('socket realtime explicit transcript consumers', () => {
  let unregisterConsumer: (() => void) | null = null;

  beforeEach(() => {
    unregisterConsumer?.();
    unregisterConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  afterEach(() => {
    unregisterConsumer?.();
    unregisterConsumer = null;
    storage.setState(initialStorageState, true);
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  it('defers transcript for a hidden session with no explicit transcript consumer', async () => {
    const hiddenSessionId = 'hidden-detail-producer';
    storage.getState().applySessions([buildSession(hiddenSessionId)]);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      updateData: buildPlainNewMessageUpdate(hiddenSessionId),
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
  });

  it('materializes hidden durable messages while an explicit transcript consumer is mounted', async () => {
    const hiddenSessionId = 'hidden-detail-producer';
    storage.getState().applySessions([buildSession(hiddenSessionId)]);
    unregisterConsumer = registerSessionRealtimeTranscriptConsumer(hiddenSessionId);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      updateData: buildPlainNewMessageUpdate(hiddenSessionId),
    });

    expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
    expect(applyMessages).toHaveBeenCalledTimes(1);
    const [appliedSessionId, messages] = applyMessages.mock.calls[0] as [string, NormalizedMessage[]];
    expect(appliedSessionId).toBe(hiddenSessionId);
    expect(messages[0]).toMatchObject({
      id: 'message-transcript-consumer',
      seq: 2,
      role: 'agent',
      content: [{ type: 'text', text: 'streaming detail pane output' }],
    });
  });

  it('does not materialize when the explicit transcript consumer belongs to another server with the same session id', async () => {
    const sharedSessionId = 'shared-session';
    storage.getState().applySessions([buildSession(sharedSessionId, { serverId: 'server-b' })]);
    unregisterConsumer = registerSessionRealtimeTranscriptConsumer(sharedSessionId);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      sourceServerId: 'server-a',
      updateData: buildPlainNewMessageUpdate(sharedSessionId),
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
  });

  it('does not materialize when a pre-hydration explicit consumer hydrates onto another server later', async () => {
    const sharedSessionId = 'shared-session';
    unregisterConsumer = registerSessionRealtimeTranscriptConsumer(sharedSessionId);
    storage.getState().applySessions([buildSession(sharedSessionId, { serverId: 'server-b' })]);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      sourceServerId: 'server-a',
      updateData: buildPlainNewMessageUpdate(sharedSessionId),
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
  });

  it('materializes explicit transcript consumers registered under an equivalent server profile alias', async () => {
    const sharedSessionId = 'shared-session';
    const profile = upsertServerProfile({
      serverUrl: 'https://server-a.example.test',
      name: 'Server A',
      source: 'manual',
    });
    setServerProfileIdentityForUrl(profile.serverUrl, 'srv_server_a');
    storage.getState().applySessions([buildSession(sharedSessionId, { serverId: profile.id })]);
    unregisterConsumer = registerSessionRealtimeTranscriptConsumer(sharedSessionId, profile.id);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      sourceServerId: 'srv_server_a',
      updateData: buildPlainNewMessageUpdate(sharedSessionId),
    });

    expect(markSessionTranscriptDeferred).not.toHaveBeenCalled();
    expect(applyMessages).toHaveBeenCalledTimes(1);
  });

  it('does not materialize when only another server marks the same session id visible', async () => {
    const sharedSessionId = 'shared-session';
    storage.getState().applySessions([buildSession(sharedSessionId, { serverId: 'server-b' })]);
    markSessionSurfaceVisible(sharedSessionId);

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      sourceServerId: 'server-a',
      updateData: buildPlainNewMessageUpdate(sharedSessionId),
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
  });

  it('stops materializing once the explicit transcript consumer unmounts', async () => {
    const hiddenSessionId = 'hidden-detail-producer';
    storage.getState().applySessions([buildSession(hiddenSessionId)]);
    const unregister = registerSessionRealtimeTranscriptConsumer(hiddenSessionId);
    unregister();

    const applyMessages = vi.fn();
    const markSessionTranscriptDeferred = vi.fn();

    await handleUpdateContainer({
      ...buildBaseParams({ applyMessages, markSessionTranscriptDeferred }),
      updateData: buildPlainNewMessageUpdate(hiddenSessionId),
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledTimes(1);
  });

});
