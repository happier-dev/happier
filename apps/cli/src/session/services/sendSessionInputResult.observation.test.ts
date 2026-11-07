import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { waitForSessionInputResult } from './sendSessionMessage';
import { configuration } from '@/configuration';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { observeWorkflowSessionInputResult } from '@/daemon/workflows/stepExecution';
import { SessionInputAuthorityV2Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { stampTurnFacts } from '@/agent/runtime/session/turn/stampTurnFacts';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { WORKFLOW_STEP_INPUT_EVENT_MESSAGE } from '@/session/shared/sessionTurnLifecycle';
import { CoordinationMessageRefV1Schema } from '@happier-dev/protocol/discussions/messageRefs';
import { classifyWorkflowSessionInputResult } from '@/daemon/workflows/stepExecution';
import { applyWorkflowInvocationFactV1, WorkflowProgressEnvelopeV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createWorkflowInvocationRecoveryObserver } from '@/daemon/workflows/invocationRecoveryObserver';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createWorkflowSessionStepExecutor } from '@/daemon/workflows/sessionStepExecutor';
import { createWorkflowCoordinator, WorkflowRuntimeInterruption } from '@/daemon/workflows/coordinator';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { openWorkflowProgressStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { deriveActivitySummaryFromAgentState } from '@/api/session/deriveActivitySummaryFromAgentState';
import type { AgentState } from '@/api/types';

const socketBoundary = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@/api/session/sockets', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/session/sockets')>(),
  createSessionScopedSocket: socketBoundary.create,
  createSessionScopedSocketConnection: () => {
    const socket = socketBoundary.create();
    return { socket, transport: createSocketTransportAdapter(socket) };
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['weekly', 'unknown-reset', 'ordinary-failure', 'legacy-bare'] as const)(
  'retains a failed original reply diagnostic through the real Workflow Run attention (%s)', async scenario => {
  const sessionId = 'c' + 'b'.repeat(24), runId = 'quota-reply-run', accountId = 'account', machineId = 'machine';
  const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
  const definition = { version: 1 as const, inputs: [], defaults: {
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
  }, blocks: [{ kind: 'step' as const, id: 'work', document: { text: 'Work', references: [], attachments: [] },
    input: [], result: { kind: 'text' as const } }] };
  const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: workspace }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
  if (!materialized.ok) throw new Error(materialized.error.code);
  const stored = createWorkflowRunStorageTestkit({ runId, accountId, machineId, origin: { kind: 'direct' } });
  const rootRecordId = 'root';
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '1',
    frontier: { nextBlockOrdinal: 0, paused: false } };
  await stored.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootRecordId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootRecordId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootRecordId } })) } });
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId,
    checkpoint, encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    storage: stored, revision: stored.run().revision });
  const quota = scenario === 'weekly' || scenario === 'unknown-reset';
  const preview = scenario === 'legacy-bare' ? "You've hit your weekly limit · resets Nov 9, 4pm (Europe/Amsterdam)"
    : quota ? 'Usage limit reached' : 'Provider rejected the requested model.';
  // Providers claude-ratelimit-issue-1107 owns the native weekly text/reset:
  // classifyPrimarySessionRuntimeIssue.claudeSdk.test.ts proves this emitted shape.
  const issue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed',
    code: quota ? 'usage_limit' : scenario === 'legacy-bare' ? 'claude_rate_limit' : 'model_not_found',
    source: quota ? 'usage_limit' : 'agent_session_error',
    agentId: 'claude', occurredAt: Date.parse('2026-11-07T09:52:00Z'), sanitizedPreview: preview,
    ...(quota ? { usageLimit: { v: 1,
      resetAtMs: scenario === 'weekly' ? Date.parse('2026-11-09T15:00:00Z') : null,
      retryAfterMs: null, quotaScope: 'account', recoverability: 'switch_account',
      connectedService: { serviceId: 'happier.agent.claude/claude-subscription',
        profileId: 'issued-profile', groupId: 'issued-pool' },
    } } : {}),
  });
  let localId = '', invocationRecordId = '';
  socketBoundary.create.mockReturnValue(Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  }));
  // Only the authenticated Home transport is substituted; exact-input lookup,
  // reply custody, turn decoding, step execution and durable Run projection stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: 'failed-turn', outcome: { kind: 'failed' } } } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: {
      id: 'input-row', localId, seq: 7, createdAt: 7, updatedAt: 7, content: { t: 'plain', v: {
        role: 'user', content: { type: 'text', text: 'Work' }, meta: { happierInputAuthorityV1: {
          v: 2, producer: 'workflow', caller: { kind: 'host' },
          permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' },
          workflow: { runId, invocationRecordId, purpose: 'invocation', stepOrdinal: '1', workDepth: 1 },
        } } } },
    } } };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 12, turns: [
      { turnId: 'unrelated-turn', status: 'failed', startedAt: 1, updatedAt: 2, terminalAt: 2,
        lastRuntimeIssue: { ...issue, code: 'unrelated-private-issue' },
        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], endSeqInclusive: 2 } },
      { turnId: 'failed-turn', status: 'failed', startedAt: 7, updatedAt: 12, terminalAt: 12,
        workflowInvocation: { runId, invocationRecordId }, lastRuntimeIssue: issue,
        transcriptAnchors: { startUserMessageSeq: 7, userMessageSeqs: [7], startSeqInclusive: 7, endSeqInclusive: 12 } },
    ] } };
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [] } };
    throw new Error(`unexpected_quota_reply_read:${url}`);
  });
  const execute = createWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
    prepareConversation: async () => { throw new Error('Retained input needs no preparation'); },
    materializeConversation: async () => { throw new Error('Retained input needs no materialization'); } });
  const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootRecordId,
    resolveWorkspace: async () => ({ ok: true, workspace }), executeStep: async params => {
      invocationRecordId = params.invocationRecordId!;
      localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId });
      const execution = { kind: 'session' as const, sessionId, localInputId: localId };
      await params.onInputAccepted(execution);
      return execute({ ...params, invocation: { ...params.invocation, execution } });
    } });
  await expect(coordinator.run({ ...materialized.snapshot, runId, signal: new AbortController().signal }))
    .resolves.toMatchObject({ state: 'interrupted' });
  expect(stored.run()).toMatchObject({ attentionRequired: quota, invocationAttentionRequired: quota });
  const leaf = stored.rowById(invocationRecordId)!;
  expect(leaf.index.lifecycle).toBe(quota ? 'needs_attention' : 'failed');
  const opened = openWorkflowProgressStoredEnvelopeV1({ mode: 'plain', envelope: JSON.parse(leaf.contentEnvelope),
    binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: invocationRecordId,
      sequence: leaf.index.sequence, parentRecordId: leaf.index.parentRecordId, memberOrdinal: leaf.index.memberOrdinal,
      attempt: leaf.index.attempt } });
  if (opened.kind !== 'available') throw new Error(opened.kind);
  const progress = opened.content;
  expect(progress.replyOutcome).toEqual({ kind: 'failed' });
  expect(progress.reason).toMatchObject({ code: 'session_input_failed', runtimeIssueV1: {
    code: issue.code, sanitizedPreview: preview, source: quota ? 'usage_limit' : 'agent_session_error',
    ...(quota ? { usageLimit: issue.usageLimit } : {}),
  } });
});

it('pushes a native tool approval and its decision into the Workflow Run attention without duplicate publications', async () => {
  const sessionId = 'c' + 'a'.repeat(24), runId = 'native-approval-run', accountId = 'account', machineId = 'machine';
  const workspace = { machineId, directory: '/repo', checkoutRootPath: '/repo' };
  const definition = { version: 1 as const, inputs: [], defaults: {
    agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  }, blocks: [{ kind: 'step' as const,
    id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } }] };
  const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition,
    context: { source: { kind: 'inline' }, inputs: {}, machineId, executionTarget: { kind: 'session' },
      workspaceTarget: { project: workspace }, authorization: { principal: { kind: 'host' } } },
    admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
  if (!materialized.ok) throw new Error(materialized.error.code);
  const stored = createWorkflowRunStorageTestkit({ runId, accountId, machineId, origin: { kind: 'direct' } });
  const rootRecordId = 'root';
  const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId, nextSequence: '1',
    frontier: { nextBlockOrdinal: 0, paused: false } };
  await stored.execute({ operation: 'initialize', runId, expectedRevision: 0,
    checkpointEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'checkpoint', accountId, runId }, checkpoint })),
    rootInvocation: { id: rootRecordId, contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: rootRecordId,
        sequence: '0', parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
        invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootRecordId } })) } });
  const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId,
    checkpoint, encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } },
    storage: stored, revision: stored.run().revision });
  const socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
  socketBoundary.create.mockReturnValue(socket);
  let localId = '', invocationRecordId = '', finished = false;
  let agentState: AgentState = { requests: {} };
  const turnId = 'native-turn';
  const requests: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    requests.push(url);
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, encryptionMode: 'plain', metadata: '{}',
      pendingPermissionRequestCount: deriveActivitySummaryFromAgentState(agentState).pendingPermissionRequestCount,
      pendingUserActionRequestCount: 0 }) } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId: turnId } } };
    const input = { id: 'input-row', localId, seq: 1, createdAt: 1, updatedAt: 1, content: { t: 'plain', v: {
      role: 'user', content: { type: 'text', text: 'Work' }, meta: { happierInputAuthorityV1: {
        v: 2, producer: 'workflow', caller: { kind: 'host' },
        permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' },
        workflow: { runId, invocationRecordId, purpose: 'invocation', stepOrdinal: '1', workDepth: 1 },
      } } } } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 2, turns: [{ turnId,
      status: finished ? 'completed' : 'in_progress', startedAt: 1, updatedAt: 2, initiator: 'workflow', workDepth: 1,
      workflowInvocation: { runId, invocationRecordId }, transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1],
        ...(finished ? { finalAssistantMessageSeq: 2, endSeqInclusive: 2 } : {}) } }] } };
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [input, ...(finished ? [{
      id: 'answer', localId: null, seq: 2, createdAt: 2, updatedAt: 2, content: { t: 'plain', v:
        buildAcpAgentMessageEnvelope({ provider: 'external-agent', body: { type: 'message', message: 'Done' },
          meta: { runtimeTurnId: turnId, runtimeEventKind: 'transcript-message-committed' } }) },
    }] : [])] } };
    throw new Error(`unexpected_approval_read:${url}`);
  });
  const execute = createWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null },
    prepareConversation: async () => { throw new Error('Retained input needs no preparation'); },
    materializeConversation: async () => { throw new Error('Retained input needs no materialization'); } });
  const coordinator = createWorkflowCoordinator({ store, rootInvocationRecordId: rootRecordId,
    resolveWorkspace: async () => ({ ok: true, workspace }), executeStep: async params => {
      // Start at the already admitted native input, then retain the production
      // Session observer, leaf adapter, coordinator, envelope and Run projection.
      invocationRecordId = params.invocationRecordId!;
      localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', runId, invocationRecordId });
      const execution = { kind: 'session' as const, sessionId, localInputId: localId };
      await params.onInputAccepted(execution);
      return execute({ ...params, invocation: { ...params.invocation, execution } });
    } });
  let controller = new AbortController();
  let running = coordinator.run({ ...materialized.snapshot, runId, signal: controller.signal });
  try {
    await vi.waitFor(() => expect(socket.listenerCount('update')).toBeGreaterThan(0));
    await vi.waitFor(() => expect(requests.some(url => url.endsWith('/turns'))).toBe(true));
    const push = () => socket.emit('update', { id: 'approval-update', seq: 1, createdAt: 2,
      body: { t: 'update-session', id: sessionId,
        pendingPermissionRequestCount: deriveActivitySummaryFromAgentState(agentState).pendingPermissionRequestCount,
        pendingUserActionRequestCount: 0 } });
    const approval = { tool: 'Bash', kind: 'permission' as const, arguments: { command: 'pwd' }, createdAt: 2, turnId };
    agentState = { requests: { 'exec-native': approval } }; push();
    await vi.waitFor(() => expect(stored.run()).toMatchObject({ state: 'running', attentionRequired: true, invocationAttentionRequired: true }));
    const attentionRevision = stored.run().revision;
    controller.abort('workflow_runtime_interrupted');
    await running.catch(error => { if (!(error instanceof WorkflowRuntimeInterruption)) throw error; });
    const turnReads = requests.filter(url => url.endsWith('/turns')).length;
    controller = new AbortController();
    running = coordinator.run({ ...materialized.snapshot, runId, signal: controller.signal });
    await vi.waitFor(() => expect(requests.filter(url => url.endsWith('/turns')).length).toBeGreaterThan(turnReads));
    expect(stored.run()).toMatchObject({ invocationAttentionRequired: true, revision: attentionRevision });
    const snapshotReads = () => requests.filter(url => url.endsWith(`/v2/sessions/${sessionId}`)).length;
    const beforePushReads = snapshotReads();
    for (let index = 0; index < 3; index += 1) push();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stored.run().revision).toBe(attentionRevision);
    expect(snapshotReads()).toBe(beforePushReads);
    agentState = { requests: { 'exec-native': approval }, completedRequests: {
      'exec-native': { ...approval, status: 'approved', completedAt: 3 },
    } }; push();
    await vi.waitFor(() => expect(stored.run()).toMatchObject({ state: 'running', attentionRequired: false, invocationAttentionRequired: false }));
    expect(stored.run().revision).toBe(attentionRevision + 1);
    // Recover both edges when the socket missed the native request/decision.
    agentState = { requests: { 'exec-native': approval } };
    socket.emit('connect');
    await vi.waitFor(() => expect(stored.run().invocationAttentionRequired).toBe(true));
    agentState = { requests: {} };
    socket.emit('connect');
    await vi.waitFor(() => expect(stored.run().invocationAttentionRequired).toBe(false));
  } finally {
    finished = true;
    controller.abort('workflow_runtime_interrupted');
    socket.emit('ephemeral', { type: 'session-message-reply-pending-v1', v: 1, sessionId, requestLocalId: localId });
    await running.catch(error => { if (!(error instanceof WorkflowRuntimeInterruption)) throw error; });
  }
});

it('rejoins only the original completed Workflow turn when retained reply anchors are incomplete', async () => {
  const sessionId = 'c' + 'b'.repeat(24);
  const workflowInvocation = { runId: 'retained-run', invocationRecordId: '00000000-0000-4000-8000-000000000003' };
  const localId = deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...workflowInvocation });
  const turnId = 'native-turn-retained-2';
  let status: 'in_progress' | 'completed' = 'in_progress';
  let acceptedTurnId = turnId;
  let finalAssistantMessageSeq: number | null | undefined = null;
  let endSeqInclusive: number | undefined;
  let outcome: SessionMessageReplyOutcomeV1 | undefined;
  let discussionWorkflow = false;
  let invocation = workflowInvocation;
  let answerVisible = true;
  let onNativeTranscriptRead: (() => void) | undefined;
  const socket = Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  });
  socketBoundary.create.mockReturnValue(socket);
  const row = (seq: number, value: unknown, inputLocalId: string | null = null) => ({
    id: `retained-row-${seq}`, localId: inputLocalId, seq, createdAt: seq, updatedAt: seq,
    content: { t: 'plain', v: value },
  });
  const inputBody = { role: 'user', content: { type: 'text', text: 'Work' }, meta: {
    happierInputAuthorityV1: SessionInputAuthorityV2Schema.parse({
      v: 2, producer: 'workflow', caller: { kind: 'host' },
      permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' },
      workflow: { ...workflowInvocation, purpose: 'invocation', stepOrdinal: '1', workDepth: 1 },
    }),
  } };
  const input = row(3, inputBody, localId);
  const assistant = (seq: number, text: string, runtimeTurnId: string, extra: Record<string, unknown> = {}, sidechainId?: string) => row(seq,
    buildAcpAgentMessageEnvelope({ provider: 'external-agent', body: { type: 'message', message: text,
      ...(sidechainId ? { sidechainId } : {}) },
    meta: { runtimeTurnId, runtimeEventKind: 'transcript-message-committed', ...extra } }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: 'wait', disposition: 'observing', acceptedTurnId, ...(outcome ? { outcome } : {}),
      ...(discussionWorkflow ? { workflow: { purpose: 'invocation', ...workflowInvocation }, discussion: {
        discussionId: 'discussion-1', messageId: 'question-1', throughSeq: 1, participantSessionId: sessionId,
      } } : {}),
    } } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 20, turns: [{
      turnId, status, startedAt: 3, updatedAt: 6, initiator: 'workflow', workDepth: 1, workflowInvocation: invocation,
      transcriptAnchors: { ...(finalAssistantMessageSeq === undefined ? {} : { finalAssistantMessageSeq }),
        ...(endSeqInclusive === undefined ? {} : { endSeqInclusive }) },
    }, { turnId: 'later-turn', status: 'completed', startedAt: 10, updatedAt: 12,
      initiator: 'workflow', workDepth: 1, workflowInvocation: { ...workflowInvocation,
        invocationRecordId: '00000000-0000-4000-8000-000000000004' },
      transcriptAnchors: { startUserMessageSeq: 10, userMessageSeqs: [10], finalAssistantMessageSeq: 12 },
    }] } };
    if (url.includes('/messages?')) {
      onNativeTranscriptRead?.();
      return { status: 200, data: { hasMore: false, messages: [input,
      ...(answerVisible ? [assistant(5, 'QA-FIN80 CHILD DONE', turnId)] : []),
      assistant(6, 'Other child', turnId, {}, 'sidechain'),
      assistant(7, 'Unfinished checkpoint', turnId, { runtimeEventKind: 'streaming',
        happierStreamSegmentV1: { segmentKind: 'assistant', segmentState: 'streaming' } }),
      assistant(12, 'Wrong later answer', 'later-turn'),
      ] } };
    }
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: false }) } };
    throw new Error(`unexpected_retained_read:${url}`);
  });
  const observe = () => observeWorkflowSessionInputResult({ credentials: { token: 'token', encryption: null },
    sessionId, localId, deadlineMs: 0 });
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  status = 'completed';
  const result = await observe();
  expect(result).toMatchObject({ ok: true, result: { kind: 'final_text', text: 'QA-FIN80 CHILD DONE',
    messageRef: { messageId: 'retained-row-5' } } });
  if (!result.ok) throw new Error('retained_input_unavailable');
  expect(classifyWorkflowSessionInputResult(result.result)).toMatchObject({ kind: 'completed', result: 'QA-FIN80 CHILD DONE' });
  // A Discussion Workflow needs the original C2 fact in its immutable terminal
  // row. Native prose alone may still recover the ordinary retained turn above.
  discussionWorkflow = true;
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  let nativeTranscriptRead = () => {};
  const nativeRead = new Promise<void>(resolve => { nativeTranscriptRead = resolve; });
  onNativeTranscriptRead = nativeTranscriptRead;
  const waitingForCustody = observeWorkflowSessionInputResult({ credentials: { token: 'token', encryption: null }, sessionId, localId });
  await nativeRead;
  outcome = { kind: 'answer', result: { sessionId, messageId: 'retained-row-5' } };
  socket.emit('ephemeral', { type: 'session-message-reply-pending-v1', v: 1, sessionId, requestLocalId: localId });
  await expect(waitingForCustody).resolves.toMatchObject({ ok: true, result: { kind: 'final_text', text: 'QA-FIN80 CHILD DONE' }, replyOutcome: outcome });
  onNativeTranscriptRead = undefined;
  // A reclaimed observer may first see C2 after C3 has replaced the native
  // result reference with its committed Discussion publication reference.
  outcome = { kind: 'answer', publicationRef: { kind: 'discussion',
    discussion: { serverId: 'home', discussionId: 'discussion-1' }, messageId: 'published-answer' } };
  await expect(observe()).resolves.toMatchObject({ ok: true,
    result: { kind: 'final_text', text: 'QA-FIN80 CHILD DONE', messageRef: { messageId: 'retained-row-5' } }, replyOutcome: outcome });
  acceptedTurnId = 'later-turn';
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  acceptedTurnId = turnId;
  discussionWorkflow = false;
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'fulfilled', outcome } });
  outcome = undefined;
  discussionWorkflow = false;
  const recover = createWorkflowInvocationRecoveryObserver({ credentials: { token: 'token', encryption: null },
    machineId: 'machine-1', now: () => 0, actionExecutor: { execute: async () => { throw new Error('No detached Run'); } } });
  await expect(recover({ terminalParent: true, cancellationRequested: true,
    run: { id: workflowInvocation.runId, state: 'cancelled' }, index: { id: workflowInvocation.invocationRecordId },
    progress: WorkflowProgressEnvelopeV1Schema.parse({ kind: 'happier.workflow-progress.v1', blockKind: 'step',
      invocationPath: { blockId: 'child', scope: [{ kind: 'workflow', blockId: 'nested' }] }, attempt: '0',
      logicalInvocationRecordId: workflowInvocation.invocationRecordId,
      execution: { kind: 'session', sessionId, localInputId: localId },
    }),
  })).resolves.toMatchObject({ kind: 'completed', result: 'QA-FIN80 CHILD DONE' });
  // The same retained turn may lack the anchor entirely, not just carry null.
  finalAssistantMessageSeq = undefined;
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'final_text', text: 'QA-FIN80 CHILD DONE' } });
  // Delayed transcript ACKs can also leave the retained terminal range short.
  endSeqInclusive = 3;
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'final_text', text: 'QA-FIN80 CHILD DONE' } });
  endSeqInclusive = undefined;
  answerVisible = false;
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  answerVisible = true;
  acceptedTurnId = 'later-turn';
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  acceptedTurnId = turnId;
  invocation = { ...workflowInvocation, invocationRecordId: '00000000-0000-4000-8000-000000000005' };
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  invocation = workflowInvocation;
  const authority = inputBody.meta.happierInputAuthorityV1;
  inputBody.meta.happierInputAuthorityV1 = SessionInputAuthorityV2Schema.parse({ ...authority, workflow: {
    ...workflowInvocation, purpose: 'invocation', stepOrdinal: '1', workDepth: 1,
    invocationRecordId: '00000000-0000-4000-8000-000000000005',
  } });
  await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  inputBody.meta.happierInputAuthorityV1 = authority;
  for (const kind of ['pass', 'declined', 'cancelled', 'failed', 'terminal_no_result'] as const) {
    outcome = { kind };
    await expect(observe()).resolves.toMatchObject({ ok: true, result: { kind: 'fulfilled', outcome: { kind } } });
  }
});

it.each(['cancelled', 'failed'] as const)('observes original pre-provider %s without inventing a committed input', async kind => {
  const sessionId = 'c' + 'd'.repeat(24);
  let replyVisible = false;
  let replyReads = 0;
  socketBoundary.create.mockReturnValue(Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/by-local-id/original/reply')) {
      replyReads += 1;
      return { status: 200, data: replyVisible ? {
        v: 1, status: 'available', progress: { v: 1, mode: 'wait', disposition: 'observing', outcome: { kind } },
      } : { v: 1, status: 'unavailable' } };
    }
    if (url.endsWith('/by-local-id/original')) throw Object.assign(new Error('Message not found'), {
      isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
    });
    if (url.includes('/pending')) return { status: 200, data: { pending: [] } };
    if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_pre_provider_read:${url}`);
  });
  const input = { credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId: 'original',
    observation: { kind: 'absolute_deadline', deadlineMs: 0 } } as const;
  expect(await waitForSessionInputResult(input)).toMatchObject({ ok: true, result: { kind: 'pending' } });
  expect(replyReads).toBe(0);
  expect(await waitForSessionInputResult({ ...input, observeReply: true }))
    .toMatchObject({ ok: true, result: { kind: 'pending' } });
  replyVisible = true;
  const result = await waitForSessionInputResult({ ...input, observeReply: true });
  expect(result).toMatchObject({ ok: true, result: { kind: 'fulfilled', outcome: { kind } }, replyOutcome: { kind } });
  expect(result).not.toHaveProperty('inputMessageRef');
});

it.each(['pass', 'answer'] as const)('settles an explicit pass or answer (%s) from original reply custody without an unrelated final', async kind => {
  const sessionId = 'c' + 'a'.repeat(24);
  socketBoundary.create.mockReturnValue(Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  }));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/by-local-id/question-1/reply')) return { status: 200, data: {
      v: 1, status: 'available', progress: { v: 1, mode: 'wait', acceptedTurnId: 'answer-turn',
        disposition: 'observing', outcome: kind === 'pass' ? { kind: 'pass' }
          : { kind: 'answer', result: { sessionId, messageId: 'committed-explicit-answer' } } } } };
    if (url.endsWith('/by-local-id/question-1')) return { status: 200, data: { message: {
      id: 'committed-question', localId: 'question-1', seq: 7, createdAt: 7, updatedAt: 7,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Anything to add?' } } },
    } } };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 7, turns: [] } };
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [
      { id: 'committed-explicit-answer', seq: 8, createdAt: 8, content: { t: 'plain', v: {
        role: 'agent', content: { type: 'text', text: 'Use revision abc123' } } } },
      { id: 'unrelated-final', seq: 9, createdAt: 9, content: { t: 'plain', v: {
        role: 'agent', content: { type: 'text', text: 'Wrong later answer' } } } },
    ] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_reply_read:${url}`);
  });
  await expect(waitForSessionInputResult({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, localId: 'question-1', observeReply: true, serverId: 'captured-qualified-home',
    observation: { kind: 'absolute_deadline', deadlineMs: 0 } })).resolves.toMatchObject({
      ok: true, inputMessageRef: { session: { serverId: 'captured-qualified-home', sessionId }, messageId: 'committed-question' },
      result: kind === 'pass' ? { kind: 'fulfilled', outcome: { kind: 'pass' } }
        : { kind: 'final_text', text: 'Use revision abc123', messageRef: {
            session: { serverId: 'captured-qualified-home', sessionId }, messageId: 'committed-explicit-answer' } },
    });
});

it.each([1_900_000_000_000, null, undefined])('carries the exact failed turn usage-limit issue into strict workflow progress (reset %s)', async resetAtMs => {
  const sessionId = 'c' + 'e'.repeat(24);
  const issue = resetAtMs === undefined ? undefined : SessionRuntimeIssueV1Schema.parse({
    v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit', occurredAt: 10,
    usageLimit: { v: 1, resetAtMs, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
  });
  const earlierIssue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed',
    code: 'agent_session_error', source: 'agent_session_error', occurredAt: 2 });
  socketBoundary.create.mockReturnValue(Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  }));
  const input = { id: 'input', localId: 'exact-input', seq: 7, createdAt: 7, updatedAt: 7,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'none' } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 12, turns: [{
      turnId: 'previous-turn', status: 'failed', startedAt: 1, updatedAt: 2, terminalAt: 2, lastRuntimeIssue: earlierIssue,
      transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], startSeqInclusive: 1, endSeqInclusive: 2 },
    }, {
      turnId: 'failed-turn', status: 'failed', startedAt: 7, updatedAt: 12, terminalAt: 12,
      ...(issue ? { lastRuntimeIssue: issue } : {}),
      transcriptAnchors: { startUserMessageSeq: 7, userMessageSeqs: [7], startSeqInclusive: 7, endSeqInclusive: 12, finalAssistantMessageSeq: null },
    }] } };
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const observed = await observeWorkflowSessionInputResult({ credentials: { token: 'token', encryption: null },
    sessionId, localId: 'exact-input', deadlineMs: 0 });
  expect(observed).toMatchObject({ ok: true, result: { kind: 'failed' } });
  if (!observed.ok) throw new Error('missing_exact_input_result');
  const result = classifyWorkflowSessionInputResult(observed.result);
  expect(result).toMatchObject({ kind: issue ? 'needs_attention' : 'failed', ...(issue ? { runtimeIssueV1: issue } : {}) });
  if (result.kind !== 'failed' && result.kind !== 'needs_attention') throw new Error('missing_failed_input_result');
  const progress = applyWorkflowInvocationFactV1(WorkflowProgressEnvelopeV1Schema.parse({
    kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] },
    attempt: '0', logicalInvocationRecordId: 'leaf',
  }), { reason: result.code, ...('runtimeIssueV1' in result ? { runtimeIssueV1: result.runtimeIssueV1 } : {}) });
  expect(progress.reason).toEqual({ code: 'session_input_failed', ...(issue ? { runtimeIssueV1: issue } : {}) });
});

it.each(['single', 'shared', 'quiet'] as const)('captures only the host-settled final reply with %s inputs and exact turn anchors', async (mode) => {
  const sessionId = 'c' + 'f'.repeat(24);
  const socket = Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  });
  socketBoundary.create.mockReturnValue(socket);
  let phase: 'opening' | 'alpha_done' | 'both_done' | 'ledger_unavailable' = 'opening';
  const row = (seq: number, localId: string | null, value: unknown) => ({
    id: `row-${seq}`, seq, localId, createdAt: seq, updatedAt: seq,
    content: { t: 'plain', v: value },
  });
  const invocation = (name: string) => ({ runId: 'workflow-run',
    invocationRecordId: name === 'alpha' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' });
  const inputId = (name: string) => mode === 'quiet'
    ? deriveWorkflowSessionInputLocalIdV2({ purpose: 'invocation', ...invocation(name) }) : `${name}-input`;
  const quietFacts = (name: string) => mode === 'quiet'
    ? stampTurnFacts({ sessionWorkDepth: 0, hostContextOnly: true,
      workflowInvocation: invocation(name), workflowWorkDepth: 1 }) : {};
  // Both inputs are durable before either native reply. Transcript adjacency
  // therefore cannot establish which input the provider actually consumed.
  const input = (seq: number, name: string, invocationRecordId: string) => row(seq, inputId(name), mode === 'quiet'
    ? buildAcpAgentMessageEnvelope({ provider: 'claude', body: { id: inputId(name), type: 'event',
      data: { type: 'message', message: WORKFLOW_STEP_INPUT_EVENT_MESSAGE } } }) : {
    role: 'user', content: { type: 'text', text: name }, meta: { happierInputAuthorityV1: SessionInputAuthorityV2Schema.parse({
      v: 2, producer: 'workflow', caller: { kind: 'host' },
      permission: { admittedPermissionCeiling: 'default', requestedPermissionCeiling: 'default' },
      workflow: { runId: 'workflow-run', invocationRecordId, purpose: 'invocation', stepOrdinal: '1', workDepth: 1 },
    }) },
  });
  const inputs = [input(7, 'alpha', '00000000-0000-4000-8000-000000000001'),
    ...(mode !== 'single' ? [input(8, 'beta', '00000000-0000-4000-8000-000000000002')] : [])];
  const text = (seq: number, value: string) => row(seq, null, { role: 'agent', content: { type: 'text', text: value } });
  const usage = (seq: number, input: number) => row(seq, null, { role: 'agent',
    content: { type: 'acp', agentId: 'codex', data: {
      type: 'token_count', scope: 'turn_delta', source: 'provider_result', tokens: { input, output: 2 },
    } } });
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.endsWith('/reply')) return { status: 200, data: { v: 1, status: 'none' } };
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: {
      message: inputs[url.endsWith(encodeURIComponent(inputId('beta'))) ? 1 : 0] } };
    if (url.endsWith('/turns') && phase === 'ledger_unavailable') return { status: 404, data: {} };
    if (url.endsWith('/turns')) return { status: 200, data: { v: 1, sessionId, updatedAt: 12,
      turns: [
        { turnId: 'alpha-turn', status: phase === 'opening' ? 'in_progress' : 'completed', startedAt: 7, updatedAt: 11,
          ...quietFacts('alpha'),
          transcriptAnchors: { ...(mode === 'quiet' ? {} : { startUserMessageSeq: 7, userMessageSeqs: [7] }), startSeqInclusive: 7,
            ...(phase === 'opening' ? {} : { endSeqInclusive: 11, finalAssistantMessageSeq: 11 }) } },
        ...(phase === 'both_done' && mode !== 'single' ? [{ turnId: 'beta-turn', status: 'completed', startedAt: 7, updatedAt: 13,
          ...quietFacts('beta'),
          transcriptAnchors: { ...(mode === 'quiet' ? {} : { startUserMessageSeq: 8, userMessageSeqs: [8] }), startSeqInclusive: 8,
            endSeqInclusive: 13, finalAssistantMessageSeq: 13 } }] : []),
      ] } };
    if (url.includes('/messages?')) {
      const rows = [...inputs, text(9, "I'll start by setting the session title"),
        ...(phase === 'opening' ? [] : [usage(10, 7), text(11, 'QA-FIN38b TOOL DONE alpha')]),
        ...(phase === 'both_done' && mode !== 'single' ? [usage(12, 9), text(13, 'QA-FIN38b TOOL DONE beta')] : [])];
      const query = new URL(url).searchParams;
      return { status: 200, data: { hasMore: false, messages: rows.filter(item => item.seq > Number(query.get('afterSeq') ?? 0)) } };
    }
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const observe = (localId: string) => observeWorkflowSessionInputResult({
    credentials: { token: 'token', encryption: null }, sessionId, localId, deadlineMs: 0,
  });
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  if (mode !== 'single') await expect(observe(inputId('beta'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  phase = 'alpha_done';
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true,
    inputMessageRef: { kind: 'session', session: { serverId: configuration.activeServerId, sessionId }, messageId: 'row-7' },
    result: { kind: 'final_text', text: 'QA-FIN38b TOOL DONE alpha', usage: { inputTokens: 7, outputTokens: 2 },
      messageRef: { kind: 'session', session: { serverId: configuration.activeServerId, sessionId }, messageId: 'row-11' } } });
  if (mode !== 'single') await expect(observe(inputId('beta'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
  phase = 'both_done';
  for (const name of mode !== 'single' ? ['alpha', 'beta'] : ['alpha']) {
    const answer = await observe(inputId(name));
    expect(answer).toMatchObject({ ok: true,
      result: { kind: 'final_text', text: `QA-FIN38b TOOL DONE ${name}`,
        messageRef: { kind: 'session', session: { serverId: configuration.activeServerId, sessionId },
          messageId: name === 'alpha' ? 'row-11' : 'row-13' },
        usage: { inputTokens: name === 'alpha' ? 7 : 9, outputTokens: 2 } } });
    if (!answer.ok || answer.result.kind !== 'final_text') throw new Error('missing_committed_result');
    // Feed the real Session producer into C3's sole cross-resource union.
    expect(CoordinationMessageRefV1Schema.parse(answer.result.messageRef)).toEqual({
      kind: 'session', session: { serverId: configuration.activeServerId, sessionId },
      messageId: name === 'alpha' ? 'row-11' : 'row-13',
    });
    expect(CoordinationMessageRefV1Schema.parse(answer.inputMessageRef)).toMatchObject({
      kind: 'session', messageId: name === 'alpha' ? 'row-7' : 'row-8',
    });
  }
  phase = 'ledger_unavailable';
  await expect(observe(inputId('alpha'))).resolves.toMatchObject({ ok: true, result: { kind: 'pending' } });
});

it('does not mint a committed reference when current access is refused', async () => {
  vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('Forbidden'), {
    isAxiosError: true, response: { status: 403, data: { error: 'forbidden' } },
  }));
  const answer = await waitForSessionInputResult({ credentials: { token: 'revoked', encryption: null },
    idOrPrefix: 'c' + 'a'.repeat(24), localId: 'accepted-input',
    observation: { kind: 'absolute_deadline', deadlineMs: 0 } });
  expect(answer).toMatchObject({ ok: false });
  expect(answer).not.toHaveProperty('inputMessageRef');
  expect(answer).not.toHaveProperty('result.messageRef');
});

it('keeps the containing deadline authoritative when a change races a parked read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const socket = Object.assign(new EventEmitter(), {
    connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn(),
  });
  socketBoundary.create.mockReturnValue(socket);
  const events = openSessionEventSource({ token: 'token', sessionId: 'session-1' });
  const revision = events.currentRevision();
  socket.emit('connect');
  try {
    await expect(events.waitForChange(revision, { deadlineMs: 100 })).resolves.toBe(false);
  } finally {
    await events.close();
  }
});

it.each(['materialization', 'completion'] as const)('parks exact input %s and catches completion missed while disconnected', async (phase) => {
  vi.useFakeTimers();
  const socket = Object.assign(new EventEmitter(), { connected: false, connect: vi.fn(), disconnect: vi.fn(), close: vi.fn() });
  socket.connect.mockImplementation(() => { socket.connected = true; socket.emit('connect'); });
  socket.disconnect.mockImplementation(() => { socket.connected = false; });
  socketBoundary.create.mockReturnValue(socket);
  const sessionId = 'c' + 'b'.repeat(24);
  const localId = 'input-event-1';
  const input = { id: 'input', seq: 7, localId, createdAt: 1, updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
  let completed = false;
  let materialized = phase === 'completion';
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    reads.push(url);
    if (url.endsWith('/turns')) return { status: 404, data: {} };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    if (url.includes('/messages/by-local-id/')) {
      if (!materialized) throw Object.assign(new Error('Message not found'), {
        isAxiosError: true, response: { status: 404, data: { error: 'Message not found' } },
      });
      return { status: 200, data: { message: input } };
    }
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: completed ? [input,
      { id: 'text', seq: 8, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: {
        type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Done after reconnect' } } } } },
      { id: 'done', seq: 9, localId: null, createdAt: 2, content: { t: 'plain', v: { role: 'agent', content: {
        type: 'acp', data: { type: 'task_complete', id: 'turn-1' } } } } },
    ] : [input] } };
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const result = waitForSessionInputResult({ credentials: { token: 'token', encryption: null },
    idOrPrefix: sessionId, localId, timeoutMs: 10_000 });
  await vi.advanceTimersByTimeAsync(0);
  const baselineReads = reads.length;
  // Provisional stream deltas do not change retained exact-input/turn evidence.
  socket.emit('ephemeral', { type: 'transcript-stream-segment-delta', sessionId,
    message: { localId: 'live-segment', tick: 1, baseLength: 0, createdAt: 1, updatedAt: 1,
      content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Still working' } } } } });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(reads).toHaveLength(baselineReads);
  socket.emit('disconnect', 'transport close');
  completed = true;
  materialized = true;
  await vi.advanceTimersByTimeAsync(500);
  await expect(result).resolves.toMatchObject({ ok: true, localId,
    result: { kind: 'final_text', text: 'Done after reconnect' } });
  expect(socket.eventNames()).toEqual([]);
  expect(socket.connected).toBe(false);
});

it('reads settled exact input evidence once even when resolving transport passes the observation deadline', async () => {
  const sessionId = 'c' + 'a'.repeat(24);
  const localId = 'input-1';
  let currentTime = 100;
  vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
  const input = { id: 'input-row', seq: 7, localId, createdAt: 1, updatedAt: 1,
    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Work' } } } };
  const lifecycle = (type: string) => ({ role: 'agent', content: { type: 'acp', data: { type, id: 'turn-1' } } });
  // HTTP and clock are system boundaries; resolution and transcript classification stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (url.endsWith('/turns')) return { status: 404, data: {} };
    if (url.endsWith('/v1/account/encryption/currentness')) {
      currentTime = 200;
      return { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
    }
    if (url.includes('/messages/by-local-id/')) return { status: 200, data: { message: input } };
    if (url.includes('/messages?')) return { status: 200, data: { hasMore: false, messages: [input,
      ...[lifecycle('task_started'), { role: 'agent', content: { type: 'acp', agentId: 'codex', data: { type: 'text', text: 'Done' } } }, lifecycle('task_complete')]
        .map((value, ordinal) => ({ id: `result-${ordinal}`, localId: null, seq: 8 + ordinal, createdAt: 2,
          content: { t: 'plain', v: value } })),
    ] } };
    if (url.endsWith('/pending')) return { status: 200, data: { pending: [] } };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session:
      createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', metadata: '{}', active: true }) } };
    throw new Error(`unexpected_http_read:${url}`);
  });
  const result = await waitForSessionInputResult({ credentials: { token: 'token', encryption: null }, idOrPrefix: sessionId, localId,
    observation: { kind: 'absolute_deadline', deadlineMs: 100 } });
  expect(get.mock.calls.map(([url]) => url)).toContainEqual(expect.stringContaining('/messages/by-local-id/'));
  const nativeRead = get.mock.calls.find(([url]) => url.includes('/messages/by-local-id/'));
  expect(nativeRead?.[1]?.timeout).toBe(configuration.transcriptLookupRequestTimeoutMs);
  expect(result)
    .toMatchObject({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'Done' } });
});
