import { describe, expect, it, vi } from 'vitest';

import type { AgentState, Update } from '../../../types';
import { createSessionClientUpdateRuntime } from './createSessionClientUpdateRuntime';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';

function createRuntime(
  overrides: Partial<Omit<
    Parameters<typeof createSessionClientUpdateRuntime>[0],
    'mode' | 'ctx'
  >> = {},
) {
  return createSessionClientUpdateRuntime({
    getServerIdentityId: () => 'home',
    sessionId: 'session-1',
    getMetadata: () => null,
    setMetadata: vi.fn(),
    getMetadataVersion: () => 0,
    setMetadataVersion: vi.fn(),
    getAgentState: () => null,
    setAgentState: vi.fn(),
    getAgentStateVersion: () => 0,
    setAgentStateVersion: vi.fn(),
    applyPendingQueueState: vi.fn(() => false),
    emit: vi.fn(),
    markAgentQueueEchoSuppressedLocalId: vi.fn(),
    initialLastObservedMessageSeq: 0,
    ...overrides,
    mode: 'plain',
    ctx: null,
  });
}

describe('createSessionClientUpdateRuntime', () => {
  it('advances the transcript watermark through own acknowledged writes only across a contiguous run', () => {
    const runtime = createRuntime();
    for (const seq of [1, 2, 3]) runtime.observeCommittedAck({ seq });
    expect(runtime.getLastObservedMessageSeq()).toBe(3);
    // Seq 4 belongs to someone else and has not been seen: an own ack at 5 cannot cross it.
    runtime.observeCommittedAck({ seq: 5 });
    expect(runtime.getLastObservedMessageSeq()).toBe(3);
    runtime.handleUpdate({ id: 'foreign', seq: 1, createdAt: 1, body: { t: 'new-message', delivery: 'full' as const,
      sid: 'session-1', message: { id: 'foreign-4', seq: 4, localId: null, createdAt: 1, updatedAt: 1, messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'foreign' } } } } } } as Update,
      { source: 'session-scoped' });
    expect(runtime.getLastObservedMessageSeq()).toBe(5);
  });
  it('does not treat bodyless observations as materialized or accepted runtime messages', () => {
    const emit = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const runtime = createRuntime({ emit, observeCommittedUserMessageSeq });
    runtime.handleUpdate({ id: 'hint', seq: 1, createdAt: 1,
      body: { t: 'message-updated', delivery: 'hint', sid: 'session-1', message: { id: 'm', seq: 8,
        localId: 'local', messageRole: 'user', createdAt: 1, updatedAt: 2,
        attentionImpact: { affectsUnread: true, affectsMeaningfulActivity: true } } } }, { source: 'session-scoped' });
    expect(observeCommittedUserMessageSeq).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(runtime.getLastObservedMessageSeq()).toBe(0);
  });
  it('re-observes an original without consuming its IDs or frontier when its authenticated Home is temporarily unavailable', () => {
    let serverIdentityId: string | null | undefined;
    const emit = vi.fn();
    const runtime = createRuntime({ getServerIdentityId: () => serverIdentityId, emit });
    const update = { id: 'home-update', seq: 1, createdAt: 1_000,
      body: { t: 'new-message', delivery: 'full' as const, sid: 'session-1', message: {
        id: 'home-message', localId: 'home-original', seq: 7, createdAt: 1_000, updatedAt: 1_000, messageRole: 'user',
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'person', sessionRelationship: 'owner' },
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Preserve this original' } } },
      } } } as Update;
    runtime.handleUpdate(update, { source: 'session-scoped' });
    expect(emit).not.toHaveBeenCalled();
    expect(runtime.getLastObservedMessageSeq()).toBe(0);
    expect(runtime.getLastObservedUserMessageSeq()).toBe(0);
    serverIdentityId = 'authenticated-home';
    runtime.handleUpdate(update, { source: 'session-scoped' });
    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ actionRequestAttributionV1: {
      requestRef: 'home-original', requester: { serverId: serverIdentityId, accountId: 'person' },
      persona: { serverId: serverIdentityId, sessionId: 'session-1' },
      origin: { kind: 'session', session: { serverId: serverIdentityId, sessionId: 'session-1' }, messageId: 'home-message' },
    } }));
    expect(runtime.getLastObservedMessageSeq()).toBe(7);
    expect(runtime.getLastObservedUserMessageSeq()).toBe(7);
    runtime.handleUpdate(update, { source: 'session-scoped' });
    expect(emit.mock.calls.filter(([event]) => event === 'user-message')).toHaveLength(1);
    const legacyEmit = vi.fn();
    const legacy = createRuntime({ getServerIdentityId: () => null, emit: legacyEmit });
    legacy.handleUpdate(update, { source: 'session-scoped' });
    expect(legacyEmit).toHaveBeenCalledWith('user-message', expect.objectContaining({
      content: { type: 'text', text: 'Preserve this original' }, actionRequestAttributionV1: undefined,
    }));
    expect(legacy.getLastObservedMessageSeq()).toBe(7);
  });

  it('withdraws retained questions when an exact Session archive update reaches its owner', async () => {
    let archivedAt: number | null = null;
    let state: AgentState = { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
      arguments: { questions: [{ question: 'Continue?' }] }, createdAt: 1 } }, completedRequests: {} };
    const session = { sessionId: 'session-1', getAgentStateSnapshot: () => state,
      getArchivedAtSnapshot: () => archivedAt,
      updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); },
      updateAgentStateRequestSettlement: async (update: (current: AgentState) => AgentState) => { state = update(state); } };
    const store = new AgentStateRequestStore({ session, logPrefix: '[Archive update]' });
    const runtime = createRuntime({ onArchivedAtFromServer: (value) => {
      archivedAt = value;
      store.updateSession(session);
    } });
    const archive = { id: 'archive', seq: 1, createdAt: 1_000,
      body: { t: 'update-session', id: 'other-session', archivedAt: 42 } } as Update;
    runtime.handleUpdate(archive, { source: 'user-scoped' });
    expect(store.hasOutstandingRequest('question')).toBe(true);
    runtime.handleUpdate({ ...archive, body: { ...archive.body, id: 'session-1' } } as Update, { source: 'user-scoped' });
    expect(store.hasOutstandingRequest('question')).toBe(false);
    await vi.waitFor(() => expect(state.completedRequests?.question)
      .toMatchObject({ status: 'canceled', reason: 'Session archived' }));
    store.dispose();
  });

  it('forwards transcript rows as observations without a provider-input consumer dependency', () => {
    const emit = vi.fn();
    const runtime = createRuntime({ emit });
    const update = {
      id: 'update-1', seq: 1, createdAt: 1_000,
      body: {
        t: 'new-message', delivery: 'full' as const, sid: 'session-1',
        message: {
          id: 'message-1', seq: 4, localId: 'local-1', createdAt: 1_000, updatedAt: 1_000,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'observe me' } } },
        },
      },
    } as Update;

    runtime.handleUpdate(update, { source: 'session-scoped' });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(runtime.getLastObservedUserMessageSeq()).toBe(4);
  });

  it('uses the accepted canonical Pending state for drain notification', () => {
    const canonical = { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 5 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({
      getPendingQueueState: () => canonical,
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'pending-change', seq: 1, createdAt: 1_000,
      body: { t: 'pending-changed', sid: 'session-1', pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(canonical);
  });

  it('forwards an exact execution-run target hint with the canonical Pending state', () => {
    const canonical = { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 6 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({
      getPendingQueueState: () => canonical,
      onPendingChangedDrainTrigger,
    });

    runtime.handleUpdate({
      id: 'target-pending-change', seq: 2, createdAt: 1_001,
      body: {
        t: 'pending-changed',
        sid: 'session-1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 6,
        recipient: { kind: 'execution_run', runId: 'run-1' },
      },
    } as Update, { source: 'user-scoped' });

    expect(onPendingChangedDrainTrigger).toHaveBeenCalledWith(
      canonical,
      { kind: 'execution_run', runId: 'run-1' },
      6,
    );
  });

  it('reconciles each pushed queued Execution Run target once per Pending version without a feed read', () => {
    const canonical = { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 7 } as const;
    const onPendingChangedDrainTrigger = vi.fn();
    const runtime = createRuntime({ getPendingQueueState: () => canonical, onPendingChangedDrainTrigger });
    const push = (id: string, pendingVersion: number) => runtime.handleUpdate({
      id, seq: pendingVersion, createdAt: 1_002,
      body: { t: 'pending-changed', sid: 'session-1', pendingCount: 1, pendingBlockedCount: 0, pendingVersion,
        recipient: { kind: 'execution_run', runId: 'run-a' }, pendingExecutionRunIds: ['run-a', 'run-b'] },
    } as Update, { source: 'session-scoped' });

    push('first', 7);
    push('replayed', 7);

    const runTriggers = onPendingChangedDrainTrigger.mock.calls.map(([, recipient]) => recipient?.runId);
    expect(runTriggers.sort()).toEqual(['run-a', 'run-b']);
  });
});
