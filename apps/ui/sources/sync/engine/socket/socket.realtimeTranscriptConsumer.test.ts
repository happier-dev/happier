import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { storage } from '@/sync/domains/state/storage';
import {
  markSessionSurfaceVisible,
  resetSessionSurfaceVisibilityForTests,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { Encryption } from '@/sync/encryption/encryption';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { handleUpdateContainer as applySocketUpdate } from './socket';

import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { activatePendingQueueScope } from '../pending/pendingQueueV2.testHelpers';

const initialStorageState = storage.getInitialState();
type HandleUpdateContainerParams = Parameters<typeof applySocketUpdate>[0];
let encryption: Encryption;

async function handleUpdateContainer(params: HandleUpdateContainerParams): Promise<void> {
  await applySocketUpdate(params);
  // Exercise the real coalescer and advance its canonical clock window.
  await vi.advanceTimersByTimeAsync(loadSyncTuning().sessionSocketApplyCoalescingWindowMs);
}

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

function buildPlainNewMessageUpdate(
  sessionId: string,
  options: Readonly<{
    messageId?: string;
    messageSeq?: number;
    text?: string;
    attentionImpact?: Readonly<{
      affectsUnread: boolean;
      affectsMeaningfulActivity: boolean;
    }>;
  }> = {},
): ApiUpdateContainer {
  const messageId = options.messageId ?? 'message-transcript-consumer';
  const messageSeq = options.messageSeq ?? 2;
  return {
    id: `update-${messageId}`,
    seq: messageSeq,
    createdAt: 2_000,
    body: {
      t: 'new-message',
      sid: sessionId,
      message: {
        id: messageId,
        seq: messageSeq,
        localId: null,
        createdAt: 2_000,
        updatedAt: 2_000,
        ...(options.attentionImpact ? { attentionImpact: options.attentionImpact } : {}),
        content: {
          t: 'plain',
          v: {
            role: 'agent',
            content: {
              type: 'acp',
              agentId: 'codex',
              data: { type: 'message', message: options.text ?? 'streaming detail pane output' },
            },
          },
        },
      },
    },
  } satisfies ApiUpdateContainer;
}

function buildBaseParams(overrides: Partial<Omit<HandleUpdateContainerParams, 'updateData'>> = {}) {
  return {
    encryption,
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

describe('socket realtime explicit transcript consumers', () => {
  let unregisterConsumer: (() => void) | null = null;

  beforeEach(async () => {
    await loadSyncSingletonForTests();
    storage.setState(initialStorageState, true);
    await activatePendingQueueScope({ serverId: 'socket-home', accountId: 'account-a' });
    encryption = await Encryption.create(new Uint8Array(32).fill(7));
    vi.useFakeTimers();
    unregisterConsumer?.();
    unregisterConsumer = null;
    projectManager.clear();
    resetSessionSurfaceVisibilityForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('projects a hidden post-Voice result into global attention and materializes it for the exact revealed session', async () => {
    const hiddenSessionId = 'global-voice-late-result';
    const resultMessageId = 'global-voice-late-result-message';
    storage.getState().applySessions([
      buildSession(hiddenSessionId, {
        serverId: 'srv_server_a',
        seq: 1,
        lastViewedSessionSeq: 1,
        metadata: {
          name: 'Global Voice session',
          path: '/Users/tester/project',
          host: 'tester.local',
          systemSessionV1: {
            v: 1,
            key: 'voice_conversation_retired',
            hidden: true,
          },
        },
      }),
    ]);
    expect(storage.getState().sessionListRowsByServerId.srv_server_a?.[hiddenSessionId]).toMatchObject({
      id: hiddenSessionId,
      seq: 1,
      lastViewedSessionSeq: 1,
      hasUnreadMessages: false,
    });
    const updateData = buildPlainNewMessageUpdate(hiddenSessionId, {
      messageId: resultMessageId,
      text: 'The delegated task completed after Voice ended.',
      attentionImpact: {
        affectsUnread: true,
        affectsMeaningfulActivity: true,
      },
    });
    const applyMessages = vi.fn((
      sessionId: string,
      messages: NormalizedMessage[],
    ) => {
      storage.getState().applyMessages(sessionId, messages);
    });
    const markSessionTranscriptDeferred = vi.fn();
    const params = buildBaseParams({
      applyMessages,
      markSessionTranscriptDeferred,
      sourceServerId: 'srv_server_a',
    });

    await handleUpdateContainer({
      ...params,
      updateData,
    });

    expect(applyMessages).not.toHaveBeenCalled();
    expect(markSessionTranscriptDeferred).toHaveBeenCalledWith(hiddenSessionId, {
      updateType: 'new-message',
      seq: 2,
      messageId: resultMessageId,
    });

    const projectedState = storage.getState();
    const projectedSession = projectedState.sessions[hiddenSessionId];
    expect(projectedSession).toMatchObject({
      id: hiddenSessionId,
      serverId: 'srv_server_a',
      seq: 1,
      lastViewedSessionSeq: 1,
    });
    const projectedRenderable = projectedState.sessionListRowsByServerId.srv_server_a?.[hiddenSessionId];
    expect(projectedRenderable).toMatchObject({
      id: hiddenSessionId,
      seq: 2,
      lastViewedSessionSeq: 1,
      hasUnreadMessages: true,
    });
    if (!projectedSession || !projectedRenderable) {
      throw new Error('Expected both hidden Voice result session projections.');
    }

    const activitySource: ActivityAttentionSource = {
      isDataReady: true,
      sessionsById: { [hiddenSessionId]: projectedSession },
      sessionMessagesById: projectedState.sessionMessages,
      sessionListRowsByServerId: {
        srv_server_a: { [hiddenSessionId]: projectedRenderable },
      },
      ordinarySessionListMembershipByServerId: {},
      sessionListIndexByServerId: { srv_server_a: [] },
      concurrentSessionListCacheByServerId: {},
      serverProfilesById: {
        srv_server_a: {
          id: 'srv_server_a',
          name: 'Server A',
          serverUrl: 'https://a.example.test',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: 1,
          source: 'manual',
        },
      },
      activeServer: {
        serverId: 'srv_server_a',
        serverUrl: 'https://a.example.test',
        generation: 1,
      },
    };
    const activity = buildActivityOverviewFromSource({
      source: activitySource,
      nowMs: 2_001,
      directActionsEnabled: true,
    });
    const inbox = buildInboxSessionPresentation({ overview: activity });

    expect(activity.candidates).toEqual([
      expect.objectContaining({
        sessionId: hiddenSessionId,
        route: `/session/${hiddenSessionId}?serverId=srv_server_a`,
        reasons: expect.objectContaining({ hasUnread: true }),
      }),
    ]);
    expect(inbox.sessionsNeedingAttention).toEqual([]);
    // Transport-owned unread remains truthful while the turn is still active,
    // but Inbox follows the canonical Session-list readiness projection rather
    // than turning each streamed message into a new Inbox task.
    expect(inbox.readySessions).toEqual([]);
    expect(inbox.markAllReadTargets).toEqual([]);

    // SessionView acquires this exact scoped visibility identity. Once revealed,
    // canonical delivery for this session must materialize instead of remaining
    // on the hidden projection-only path.
    markSessionSurfaceVisible(hiddenSessionId, 'srv_server_a');
    await handleUpdateContainer({
      ...params,
      updateData,
    });

    expect(applyMessages).toHaveBeenCalledTimes(1);
    expect(applyMessages).toHaveBeenCalledWith(hiddenSessionId, [
      expect.objectContaining({
        id: resultMessageId,
        seq: 2,
        role: 'agent',
        content: [expect.objectContaining({
          type: 'text',
          text: 'The delegated task completed after Voice ended.',
        })],
      }),
    ]);
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
    const profile = await upsertServerProfile({
      serverUrl: 'https://server-a.example.test',
      name: 'Server A',
      source: 'manual',
    });
    await setServerProfileIdentityForUrl(profile.serverUrl, 'srv_server_a');
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
