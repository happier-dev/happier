import { describe, expect, it, vi } from 'vitest';

import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { failureSignal } from '@/agent/executionRuns/controllers/failureSignal';
import { EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import { createExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import { createStreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { ExecutionRunState } from '../executionRunTypes';
import { createExecutionRunControllerMessageHandler, createExecutionRunTranscriptProjection } from './sessionStateEmission';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { normalizeRawMessage } from '@happier-dev/session-core/raw';
import { createReducer, projectSidechainMessages, reducer } from '@happier-dev/session-core/reducer';
import type { CommittedTranscriptMessageOptions } from '@/api/session/transcriptPort';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { projectWalkthroughStopExchanges } from '../../../../../../../ui/sources/components/sessions/files/walkthrough/walkthroughStopExchanges';

// One runtime, one lifetime: the signal must stay stable across calls so
// subscribers do not accumulate against a fresh controller each read.
const TEST_RUNTIME_LIFETIME_SIGNAL = new AbortController().signal;

function readPermissionDiagnostic(error: Error | null): unknown {
  return (error as (Error & { executionRunPermissionDiagnostic?: unknown }) | null)
    ?.executionRunPermissionDiagnostic;
}

function createController(opts: Readonly<{
  backend?: Partial<ExecutionRunBackendController['backend']>;
  withFailureSignal?: boolean;
}> = {}): ExecutionRunBackendController {
  let resolveTerminal!: () => void;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  const signal = opts.withFailureSignal ? failureSignal() : null;
  void signal?.promise.catch(() => {});
  return {
    kind: 'backend',
    controllerOccurrenceId: 'controller-occurrence-1',
    backend: {
      async readResumeSupport() {
        return false;
      },
      async provisionRuntime() {
        return { runtimeId: 'child_session_1' };
      },
      async deliverInput() {
        return { status: 'admitted' as const };
      },
      getRuntimeLifetimeSignal() {
        return TEST_RUNTIME_LIFETIME_SIGNAL;
      },
      async cancel() {},
      subscribeMessages() {
        return () => {};
      },
      async dispose() {},
      ...opts.backend,
    },
    backendSupportsResume: true,
    runtimeId: 'child_session_1',
    buffer: '',
    sidechainStreamBuffer: '',
    sidechainStreamKey: '',
    streamWriter: null,
    cancelled: false,
    turnCount: 1,
    turnEpoch: 1,
    turnInFlight: true,
    turnCancelReason: null,
    turnCancelEpoch: null,
    admittedLiveInterventions: [],
    admittedLiveInterventionsSignal: null,
    lastMarkerWriteAtMs: 0,
    terminalPromise,
    resolveTerminal,
    ...(signal ? { failureSignal: signal } : {}),
  };
}

function createRunningRun(): ExecutionRunState {
  return {
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'sidechain_1',
    sessionId: 'parent_session_1',
    depth: 1,
    intent: 'review',
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    backendId: 'codex',
    instructions: 'review',
    permissionMode: 'read_only',
    retentionPolicy: 'resumable',
    runClass: 'bounded',
    ioMode: 'request_response',
    status: 'running',
    startedAtMs: 1,
  };
}

describe('createExecutionRunControllerMessageHandler', () => {
  it('joins a streamed walkthrough answer to its admitted stop question after the controller advances', async () => {
    // Captured QA shape: Session seq 25 is participant_message.v1 with a stop stamp;
    // seq 26 is an ACP sidechain message with happierStreamSegmentV1 (2026-10-25).
    const ctrl = createController();
    ctrl.currentInputTurn = { turnId: 'question-turn', inputIds: ['stop-question'], state: 'active' };
    const commits: { body: ACPMessageData; options: CommittedTranscriptMessageOptions }[] = [];
    ctrl.streamWriter = createStreamedTranscriptWriter({
      provider: 'codex',
      durableCommitsRequireExplicitEnable: true,
      session: { async enqueueAgentMessageCommitted(_provider, body, options) {
        commits.push({ body, options });
        return { persisted: true, delivered: true };
      } },
    });
    const handler = createExecutionRunControllerMessageHandler({
      ctrl, runId: 'run_1', sidechainId: 'sidechain_1', ioMode: 'streaming',
      computeSidechainStreamText: text => text, sendAcp: async () => {}, parentProvider: 'codex',
      runs: new Map([['run_1', createRunningRun()]]), backendSupportsResume: true,
      writeActivityMarker: async () => {}, getNowMs: () => 1792950807023,
    });
    try {
      handler({ type: 'model-output', textDelta: 'The shortcuts tab currently shows the shared settings values.' });
      // A delayed durable flush must retain the turn of the text, not read new custody.
      ctrl.currentInputTurn = { turnId: 'later-turn', inputIds: ['later-question'], state: 'active' };
      await ctrl.streamWriter.flushAll({ reason: 'turn-end' });
      expect(commits).toHaveLength(1);
      const row = commits[0]!;
      const answer = normalizeRawMessage('answer-row', row.options.localId, 1792950807023,
        buildAcpAgentMessageEnvelope({ provider: 'codex', body: row.body, meta: row.options.meta }));
      const question = normalizeRawMessage('question-row', 'stop-question', 1792950799668, {
        role: 'user', content: { type: 'text', text: '<evidence> Stop question' },
        meta: { displayText: 'Should the shortcuts tab display shortcut-specific content?',
          scmWalkthroughQuestionV1: { resultId: 'saved-reading', revision: 1, stopIds: ['settings-ui'] },
          happier: { kind: 'participant_message.v1', payload: { recipient: { kind: 'execution_run', runId: 'run_1' } } } },
      });
      expect(question?.role).toBe('user');
      expect(answer?.role).toBe('agent');
      const state = createReducer();
      const messages = reducer(state, [...(question ? [question] : []), ...(answer ? [answer] : [])], null).messages;
      const projected = projectWalkthroughStopExchanges({ runId: 'run_1', resultId: 'saved-reading',
        stopIds: new Set(['settings-ui']), messages, runMessages: projectSidechainMessages(state, 'sidechain_1') });
      expect(projected.get('settings-ui')?.[0]?.answer).toBe('The shortcuts tab currently shows the shared settings values.');
      expect(answer?.meta?.happierExecutionRunInputTurnV1).toMatchObject({ turnId: 'question-turn', inputIds: ['stop-question'] });
    } finally { ctrl.streamWriter.discard(); }
  });

  it.each(['request_response', 'streaming'] as const)('commits an anonymous streamed message once while retaining repeated text in distinct messages (%s)', async ioMode => {
    const ctrl = createController();
    const rows = new Map<string, string>();
    let rowOrdinal = 0;
    if (ioMode === 'streaming') ctrl.streamWriter = createStreamedTranscriptWriter({
      provider: 'claude', makeLocalId: () => `row-${++rowOrdinal}`,
      session: { async enqueueAgentMessageCommitted(_provider, body, options) {
        if (body.type === 'message') rows.set(options.localId, body.message);
        return { persisted: true, delivered: false };
      } },
    });
    const handler = createExecutionRunControllerMessageHandler({
      ctrl, runId: 'run_1', sidechainId: 'sidechain_1', ioMode,
      computeSidechainStreamText: text => text, sendAcp: async () => {}, parentProvider: 'claude',
      runs: new Map([['run_1', createRunningRun()]]), backendSupportsResume: true,
      writeActivityMarker: async () => {}, getNowMs: () => 123,
    });
    handler({ type: 'model-output', textDelta: 'First draft' });
    handler({ type: 'model-output', messageId: 'first', fullText: 'Same answer.' });
    expect(ctrl.buffer).toBe('Same answer.');
    handler({ type: 'tool-call', toolName: 'Read', callId: 'read', args: {} });
    handler({ type: 'model-output', textDelta: 'Same ' });
    handler({ type: 'model-output', textDelta: 'answer.' });
    handler({ type: 'model-output', messageId: 'second', fullText: 'Same answer.' });
    expect(ctrl.buffer).toBe('Same answer.Same answer.');
    await ctrl.streamWriter?.flushAll({ reason: 'turn-end' });
    if (ioMode === 'streaming') expect([...rows.values()]).toEqual(['Same answer.', 'Same answer.']);
    ctrl.turnEpoch += 1;
    ctrl.buffer = '';
    handler({ type: 'model-output', textDelta: 'Next draft' });
    handler({ type: 'model-output', messageId: 'third', fullText: 'Next answer.' });
    expect(ctrl.buffer).toBe('Next answer.');
    ctrl.streamWriter?.discard();
  });

  it('replaces a draft in its own streamed row and retains earlier message artifacts in the run buffer', async () => {
    const ctrl = createController();
    const rows = new Map<string, string>();
    let rowOrdinal = 0;
    ctrl.streamWriter = createStreamedTranscriptWriter({
      provider: 'codex',
      makeLocalId: () => `row-${++rowOrdinal}`,
      session: {
        async enqueueAgentMessageCommitted(_provider, body, options) {
          if (body.type === 'message') rows.set(options.localId, body.message);
          return { persisted: true, delivered: false };
        },
      },
    });
    const handler = createExecutionRunControllerMessageHandler({
      ctrl, runId: 'run_1', sidechainId: 'sidechain_1', ioMode: 'streaming',
      computeSidechainStreamText: (text) => text, sendAcp: async () => {}, parentProvider: 'codex',
      runs: new Map([['run_1', createRunningRun()]]), backendSupportsResume: true,
      writeActivityMarker: async () => {}, getNowMs: () => 123,
    });
    const earlier = { type: 'model-output', messageId: 'message-1', textDelta: 'Retained artifact. ' } as const;
    handler(earlier);
    handler({ type: 'tool-call', toolName: 'Read', callId: 'tool-1', args: {} });
    await ctrl.streamWriter.flushAll({ reason: 'tool-call-boundary' });
    const draft = { type: 'model-output', messageId: 'message-2', textDelta: 'Draft' } as const;
    const corrected = { type: 'model-output', messageId: 'message-2', fullText: 'Corrected' } as const;
    handler(draft);
    handler(corrected);
    const acknowledgment = { type: 'model-output', messageId: 'message-3', fullText: ' Artifact delivered.' } as const;
    handler(acknowledgment);
    const removedDraft = { type: 'model-output', messageId: 'message-4', textDelta: 'Removed draft' } as const;
    const emptyFinal = { type: 'model-output', messageId: 'message-4', fullText: '' } as const;
    handler(removedDraft);
    handler(emptyFinal);
    await ctrl.streamWriter.flushAll({ reason: 'turn-end' });
    expect(ctrl.buffer).toBe('Retained artifact. Corrected Artifact delivered.');
    expect([...rows.values()]).toEqual(['Retained artifact. ', 'Corrected', ' Artifact delivered.', '']);
    ctrl.turnEpoch += 1;
    ctrl.buffer = '';
    const nextTurn = { type: 'model-output', messageId: 'message-1', fullText: 'Next turn' } as const;
    handler(nextTurn);
    expect(ctrl.buffer).toBe('Next turn');
    ctrl.streamWriter.discard();
  });

  it('binds native durable facts to the exact sidechain and accepted anchor, then refuses retired custody', async () => {
    let accept!: (value: 'accepted') => void;
    const ctrl = createController();
    ctrl.pendingInputAcceptance = new Promise<'accepted'>((resolve) => { accept = resolve; });
    let current = true;
    const written: unknown[] = [];
    const projection = createExecutionRunTranscriptProjection({
      controller: ctrl, sidechainId: 'sidechain-exact', isCurrent: () => current,
      session: {
        sessionId: 'parent-exact',
        async enqueueAgentMessageCommitted(provider, body, options) {
          written.push({ sessionId: this.sessionId, provider, body, options });
          return { persisted: true, delivered: false };
        },
      },
    });
    const options = { localId: 'native-fact', provenance: { kind: 'non_dependent' as const, source: 'external' as const } };
    const reservation = projection.enqueueAgentMessageCommitted!('codex', {
      type: 'output', data: { type: 'progress', marker: 'source_fact_consumed', reason: 'host_prompt_echo' },
    }, { ...options, localId: 'native-echo-reservation' });
    await Promise.resolve();
    expect(written).toMatchObject([{ body: { type: 'output', sidechainId: 'sidechain-exact' } }]);
    await expect(reservation).resolves.toEqual({ persisted: true, delivered: false });
    written.length = 0;
    const publication = projection.enqueueAgentMessageCommitted!('codex', {
      type: 'message', message: 'Run fact', sidechainId: 'untrusted-sidechain',
    }, options);
    await Promise.resolve();
    expect(written).toEqual([]);
    accept('accepted');
    await expect(publication).resolves.toEqual({ persisted: true, delivered: false });
    expect(written).toMatchObject([{ sessionId: 'parent-exact', body: { sidechainId: 'sidechain-exact' }, options: { localId: 'native-fact' } }]);
    current = false;
    await expect(projection.enqueueAgentMessageCommitted!('codex', { type: 'message', message: 'stale' }, options))
      .rejects.toMatchObject({ code: 'execution_run_transcript_custody_unavailable' });
    await expect(projection.enqueueAgentMessageCommitted!('codex', {
      type: 'output', data: { type: 'progress', marker: 'source_fact_consumed', reason: 'host_prompt_echo' },
    }, options)).rejects.toMatchObject({ code: 'execution_run_transcript_custody_unavailable' });
    expect(written).toHaveLength(1);
  });

  it('holds synchronous Run output until its exact admitted user anchor commits', async () => {
    let accept!: (value: 'accepted') => void;
    const ctrl = Object.assign(createController(), {
      pendingInputAcceptance: new Promise<'accepted'>((resolve) => { accept = resolve; }),
    });
    const published: unknown[] = [];
    const handler = createExecutionRunControllerMessageHandler({
      ctrl, runId: 'run_1', sidechainId: 'sidechain_1', ioMode: 'streaming',
      computeSidechainStreamText: (text) => text,
      sendAcp: async (_provider, message) => { published.push(message); },
      parentProvider: 'codex', runs: new Map([['run_1', createRunningRun()]]),
      backendSupportsResume: true, writeActivityMarker: async () => {}, getNowMs: () => 123,
    });
    handler({ type: 'model-output', textDelta: 'answer' });
    handler({ type: 'tool-call', callId: 'tool-1', toolName: 'Read', args: {} });
    await Promise.resolve();
    expect(ctrl.buffer).toBe('');
    expect(published).toEqual([]);
    accept('accepted');
    await vi.waitFor(() => expect(ctrl.buffer).toBe('answer'));
    await vi.waitFor(() => expect(published).not.toEqual([]));
  });

  it('accepts a large individual task delta and fails only when cumulative task output exceeds its bound', () => {
    const transcriptLimit = EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS;
    const cancelLargeDelta = vi.fn(async () => {});
    const largeDeltaCtrl = createController({ backend: { cancel: cancelLargeDelta }, withFailureSignal: true });
    const largeDeltaRuns = new Map([['run_1', { ...createRunningRun(), intent: 'task' as const }]]);
    const largeDeltaHandler = createExecutionRunControllerMessageHandler({
      ctrl: largeDeltaCtrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs: largeDeltaRuns,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    const largeDelta = 'x'.repeat((64 * 1_024) + 1);
    largeDeltaHandler({ type: 'model-output', textDelta: largeDelta });

    expect(largeDeltaCtrl.buffer).toBe(largeDelta);
    expect(cancelLargeDelta).not.toHaveBeenCalled();
    expect(largeDeltaCtrl.failureSignal?.readError()).toBeNull();

    const cancelOversizedFullText = vi.fn(async () => {});
    const oversizedFullTextCtrl = createController({
      backend: { cancel: cancelOversizedFullText },
      withFailureSignal: true,
    });
    const oversizedFullTextRuns = new Map([['run_1', { ...createRunningRun(), intent: 'task' as const }]]);
    const oversizedFullTextHandler = createExecutionRunControllerMessageHandler({
      ctrl: oversizedFullTextCtrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs: oversizedFullTextRuns,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    oversizedFullTextHandler({ type: 'model-output', fullText: 'x'.repeat(transcriptLimit + 1) });

    expect(oversizedFullTextCtrl.buffer).toBe('');
    expect(cancelOversizedFullText).toHaveBeenCalledWith('child_session_1');
    expect((oversizedFullTextCtrl.failureSignal?.readError() as Error & { executionRunErrorCode?: unknown })?.executionRunErrorCode)
      .toBe('execution_run_output_limit_exceeded');

    const cancelCumulative = vi.fn(async () => {});
    const cumulativeCtrl = createController({ backend: { cancel: cancelCumulative }, withFailureSignal: true });
    const cumulativeRuns = new Map([['run_1', { ...createRunningRun(), intent: 'task' as const }]]);
    const cumulativeHandler = createExecutionRunControllerMessageHandler({
      ctrl: cumulativeCtrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs: cumulativeRuns,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    cumulativeHandler({ type: 'model-output', fullText: 'x'.repeat(transcriptLimit) });
    cumulativeHandler({ type: 'model-output', textDelta: 'y' });

    expect(cumulativeCtrl.buffer).toHaveLength(transcriptLimit);
    expect(cancelCumulative).toHaveBeenCalledWith('child_session_1');
    expect((cumulativeCtrl.failureSignal?.readError() as Error & { executionRunErrorCode?: unknown })?.executionRunErrorCode)
      .toBe('execution_run_output_limit_exceeded');
  });

  it('applies the existing execution-result output bound to general Agent runs', () => {
    const cancel = vi.fn(async () => {});
    const ctrl = createController({ backend: { cancel }, withFailureSignal: true });
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs: new Map([['run_1', {
        ...createRunningRun(),
        intent: 'agent' as const,
        runClass: 'long_lived' as const,
      }]]),
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({
      type: 'model-output',
      fullText: 'x'.repeat(EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS + 1),
    });

    expect(ctrl.buffer).toBe('');
    expect(cancel).toHaveBeenCalledWith('child_session_1');
    expect((ctrl.failureSignal?.readError() as Error & { executionRunErrorCode?: unknown })?.executionRunErrorCode)
      .toBe('execution_run_output_limit_exceeded');
  });

  it('writes activity markers for meaningful runtime activity but not vendor session bookkeeping', async () => {
    const ctrl = createController();
    const runs = new Map([['run_1', createRunningRun()]]);
    const writeActivityMarker = vi.fn(async () => {});
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker,
      getNowMs: () => 123,
    });

    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: 'vendor_1' } });
    expect(writeActivityMarker).not.toHaveBeenCalled();

    handler({ type: 'tool-call', toolName: 'read', args: { file: 'README.md' }, callId: 'tool_1' });
    handler({ type: 'tool-result', toolName: 'read', result: 'ok', callId: 'tool_1' });
    handler({ type: 'status', status: 'running' });
    handler({ type: 'event', name: 'thinking', payload: { text: 'checking' } });
    handler({ type: 'terminal-output', data: 'running tests' } as never);
    await Promise.resolve();
    expect(writeActivityMarker).toHaveBeenCalledTimes(5);
    expect(writeActivityMarker).toHaveBeenCalledWith('run_1', 123);
  });

  it.each([false, true])('preserves the provisioned control address while recording a provider resume handle (retained: %s)', (retained) => {
    const ctrl = createController({ backend: retained ? {
      interaction: { kind: 'retained_agent_session.v1', capabilities: {
        open: ['create', 'resume'], delivery: ['newTurn'], cancel: true,
      } },
    } : {} });
    const runs = new Map([['run_1', createRunningRun()]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({ type: 'event', name: 'vendor_session_id', payload: { sessionId: 'legacy-provider-session' } });

    expect(ctrl.runtimeId).toBe('child_session_1');
    expect(runs.get('run_1')?.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: 'legacy-provider-session',
    });
  });

  it('preserves the first provider resume identity bytes and ignores later or blank-only events', () => {
    const ctrl = createController();
    const runs = new Map([['run_1', createRunningRun()]]);
    const onPublicStateUpdated = vi.fn();
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
      onPublicStateUpdated,
    });
    const opaqueProviderSessionId = '  provider\nses/AB+cd==  ';

    handler({
      type: 'event',
      name: 'provider_session_id',
      payload: { sessionId: opaqueProviderSessionId },
    });
    expect(runs.get('run_1')?.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: opaqueProviderSessionId,
    });

    const strippedSibling = opaqueProviderSessionId.trim();
    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: strippedSibling } });
    expect(runs.get('run_1')?.resumeHandle).toMatchObject({
      kind: 'provider_session.v1',
      providerSessionId: opaqueProviderSessionId,
    });
    expect(strippedSibling).not.toBe(opaqueProviderSessionId);

    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: ' \n\t ' } });
    expect(runs.get('run_1')?.resumeHandle).toMatchObject({ providerSessionId: opaqueProviderSessionId });
    expect(onPublicStateUpdated).toHaveBeenCalledTimes(1);
  });

  it('awaits the exact Workflow invocation sink before admitting the first provider resume identity as durable', async () => {
    let release!: () => void;
    let committed = false;
    const commit = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      committed = true;
    });
    const ctrl = createController();
    ctrl.workflowObservation = {
      localInputId: 'workflow-input-1',
      sink: { commit },
      usage: createExactTurnUsageAccumulator(),
    };
    const runs = new Map([['run_1', {
      ...createRunningRun(),
      // Provisioning may expose a host child address before the provider emits
      // its authoritative resumable identity.
      resumeHandle: {
        kind: 'provider_session.v1' as const,
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
        providerSessionId: 'child_session_1',
      },
    }]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: 'provider-session-1' } });
    await Promise.resolve();
    expect(commit).toHaveBeenCalledWith({
      kind: 'provider_resume_identity',
      runId: 'run_1',
      localInputId: 'workflow-input-1',
      providerResumeIdentity: expect.objectContaining({
        kind: 'provider_session.v1',
        providerSessionId: 'provider-session-1',
      }),
    });
    expect(committed).toBe(false);
    handler({ type: 'event', name: 'provider_session_id', payload: { sessionId: 'late-sibling' } });
    expect(commit).toHaveBeenCalledTimes(1);

    release();
    await expect(ctrl.pendingHostBarrier).resolves.toBeUndefined();
    expect(committed).toBe(true);
  });

  it('terminalizes static permission requests with a typed diagnostic instead of recording delivery', () => {
    const cancel = vi.fn(async () => {});
    const ctrl = createController({
      backend: { cancel },
      withFailureSignal: true,
    });
    const runs = new Map([['run_1', createRunningRun()]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    expect(() => handler({
      type: 'permission-request',
      id: 'provider-request-static',
      reason: 'write',
      payload: { toolName: 'write' },
    })).toThrow('Execution-run permission request cannot be surfaced or denied');

    expect(cancel).toHaveBeenCalledWith('child_session_1');
    expect(ctrl.pendingHostBarrier).toBeUndefined();
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'static',
      capability: 'static',
    });
  });

  it('terminalizes inline permission requests that reach the out-of-band host path', () => {
    const ctrl = createController({ withFailureSignal: true });
    const runs = new Map([['run_1', createRunningRun()]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'inline' } },
    });

    expect(() => handler({
      type: 'permission-request',
      id: 'provider-request-inline',
      reason: 'write',
      payload: { toolName: 'write' },
    })).toThrow('Execution-run permission request cannot be surfaced or denied');

    expect(ctrl.pendingHostBarrier).toBeUndefined();
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'inline_no_pending_request',
      capability: 'inline',
    });
  });

  it('terminalizes permission responses that resolve as not delivered', async () => {
    const respondToPermission = vi.fn(async () => ({
      delivered: false as const,
      reason: 'unknown_request' as const,
    }));
    const ctrl = createController({
      backend: { respondToPermission },
      withFailureSignal: true,
    });
    const runs = new Map([['run_1', createRunningRun()]]);
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'request_response',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
    });

    handler({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'responds' } },
    });
    handler({
      type: 'permission-request',
      id: 'provider-request-missing',
      reason: 'write',
      payload: { toolName: 'write' },
    });

    await expect(ctrl.pendingHostBarrier).resolves.toBeUndefined();

    expect(respondToPermission).toHaveBeenCalledWith('provider-request-missing', false);
    expect(readPermissionDiagnostic(ctrl.failureSignal?.readError() ?? null)).toEqual({
      runId: 'run_1',
      reason: 'unknown_request',
      capability: 'responds',
    });
  });

  it('routes prompt-capable requests from the host-owned backend identity without interpreting the runtime descriptor', () => {
    const respondToPermission = vi.fn(async () => ({ delivered: true as const }));
    const ctrl = createController({
      backend: {
        permissionCapability: 'responds',
        respondToPermission,
      },
    });
    const run: ExecutionRunState = {
      ...createRunningRun(),
      intent: 'delegate',
      permissionMode: 'default',
      runClass: 'long_lived',
      ioMode: 'streaming',
    };
    const runs = new Map([['run_1', run]]);
    const publishRequest = vi.fn();
    const handler = createExecutionRunControllerMessageHandler({
      ctrl,
      runId: 'run_1',
      sidechainId: 'sidechain_1',
      ioMode: 'streaming',
      computeSidechainStreamText: () => null,
      sendAcp: async () => {},
      parentProvider: 'codex',
      runs,
      backendSupportsResume: true,
      writeActivityMarker: async () => {},
      getNowMs: () => 123,
      getPermissionRequestStore: () => ({
        publishRequest,
        registerResponseTargetHandler: vi.fn(() => vi.fn()),
      }),
    });

    handler({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'provider-private-mode' },
      },
    });
    handler({
      type: 'event',
      name: 'runtime.capabilities',
      payload: { permissions: { capability: 'responds' } },
    });
    handler({
      type: 'permission-request',
      id: 'provider-request-parent',
      reason: 'write',
      payload: { toolName: 'write', input: { path: '/tmp/parent-prompt.txt' } },
    });

    expect(publishRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'execution-run:run_1:controller-occurrence-1:provider-request-parent',
      responseTarget: expect.objectContaining({
        runtimeKind: run.backendId,
        providerRequestId: 'provider-request-parent',
        controllerOccurrenceId: 'controller-occurrence-1',
      }),
    }));
    expect(respondToPermission).not.toHaveBeenCalled();
  });
});
