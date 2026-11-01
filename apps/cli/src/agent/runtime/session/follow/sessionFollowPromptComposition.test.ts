import { describe, expect, it, vi } from 'vitest';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/createHandler';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createRuntimeOverrideSynchronizers } from '@/agent/runtime/createRuntimeOverrideSynchronizers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '@/agent/runtime/session/input/providerInputOutcome';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { AgentSessionRuntime, AgentSessionRuntimeContext, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { createSessionFollowContextReconciler } from './sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './sessionFollowSourceMaterialResolver';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { normalizeInteractionTransientQuestionsV1 } from '@happier-dev/protocol/plugins/interactions/transientV1';
import { toStructuredQuestionPermissionInput } from '@/agent/permissions/structuredQuestionPermissionInput';

describe('Session Follow prompt composition through the canonical owner', () => {
  it.each(['plain', 'e2ee'] as const)('offers the exact %s worker question to its current handler with a complete actionable form', async mode => {
    const delivered = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { ...delivered, agentStateVersion: 1 };
    const requestId = 'worker-question';
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake',
      original: { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 1,
        requests: [{ requestId, createdAt: 3, turnId: 'question-turn', currentHandler: { kind: 'session', sessionId: 'destination' } }] } },
      requestEvents: [{ requestId, event: { kind: 'needs_you', type: 'decision', mode: 'wait', handling: 'manager' } }] });
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async () => ({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7',
        currentSourceSessionIds: ['source'], observations: [{ kind: 'admitted_input', localInputId: 'question-input',
          sourceSessionId: 'source', destinationSessionId: 'destination', delivered, observed, delivery, effectiveDelivery: delivery.delivery }] }),
    } });
    const ctx = { encryptionKey: new Uint8Array(32).fill(17), encryptionVariant: 'dataKey' as const };
    const material = createSessionFollowSourceMaterialResolver();
    if (mode === 'e2ee') material.installPreparedDataKey({ sourceSessionId: 'source', dataKey: ctx.encryptionKey });
    let sourceReads = 0;
    let handler = 'destination';
    let completed = false;
    const form = toStructuredQuestionPermissionInput(normalizeInteractionTransientQuestionsV1({ kind: 'questions', title: 'Release target', questions: [
      { id: 'region', prompt: 'Which region?', type: 'singleChoice', required: true, allowCustom: true,
        choices: [{ id: 'eu', label: 'Europe', description: 'Use the existing European deployment' }] },
      { id: 'reason', prompt: 'Explain the choice', type: 'text', required: true },
      ...Array.from({ length: 3 }, (_, index) => ({ id: `detail-${index}`, type: 'text' as const, required: true,
        prompt: `${'Long valid question context. '.repeat(100)}END_OF_QUESTION_${index}` })),
    ] }));
    const state = () => ({ requests: {
      [requestId]: { tool: 'AskUserQuestion', kind: 'user_action', arguments: form, createdAt: 3, turnId: 'question-turn',
        questionV1: { mode: 'wait', lasting: false, type: 'decision' }, currentHandler: { kind: 'session', sessionId: handler } },
      unrelated: { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'UNRELATED_PRIVATE_QUESTION' }] }, createdAt: 4 },
      approval: { tool: 'Bash', kind: 'permission', arguments: { command: 'PRIVATE_APPROVAL_BODY' }, createdAt: 5 },
    }, ...(completed ? { completedRequests: { [requestId]: { tool: 'AskUserQuestion', arguments: form, createdAt: 3,
      completedAt: 6, status: 'approved' } } } : {}) });
    const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
      sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async () => {
        sourceReads++;
        return SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1, source: {
          id: 'source', encryptionMode: mode, metadata: mode === 'plain' ? '{}' : encryptSessionPayload({ ctx, payload: {} }),
          archivedAt: null, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
          latestTurnStatus: 'waiting', latestTurnId: 'question-turn', latestTurnStatusObservedAt: 1,
          latestReadyEventSeq: null, latestReadyEventAt: null, meaningfulActivityAt: null, agentStateVersion: 1,
          agentState: mode === 'plain' ? JSON.stringify(state()) : encryptSessionPayload({ ctx, payload: state() }),
        }, messages: [], hasMore: false });
      } } });
    const reconcile = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 32768 });
    const prepare = () => reconcile({ signal: new AbortController().signal,
      followDeliveries: [{ delivery, localInputId: 'question-input', userMessageSeq: 2 }] });
    try {
      const prepared = await prepare();
      expect(prepared?.representedFollowLocalInputIds).toEqual(['question-input']);
      const prompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: prepared!.updates,
        workerUpdates: prepared!.workerUpdates, transformedUserText: 'Followed source changed. Read the original source context.' });
      for (const fact of [requestId, 'Which region?', 'Europe', 'Use the existing European deployment', 'Explain the choice',
        'currentHandler', 'destination', 'region', 'session.user_action.answer', 'pass_up', 'END_OF_QUESTION_2']) expect(prompt).toContain(fact);
      expect(prompt).not.toContain('UNRELATED_PRIVATE_QUESTION');
      expect(prompt).not.toContain('PRIVATE_APPROVAL_BODY');
      // Hydration and the existing final currentness check each open this exact
      // source once. The offer adds no request or corpus scan.
      expect(sourceReads).toBe(2);
      // A valid form can exceed WorkerUpdate's completion-summary allowance.
      // It must remain complete under the actual provider-context budget.
      expect(await reconcile({ signal: new AbortController().signal, maxFollowContextUtf8Bytes: 8192,
        followDeliveries: [{ delivery, localInputId: 'question-input', userMessageSeq: 2 }] })).toBeNull();
      handler = 'another-manager';
      expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(false);
      const other = await prepare();
      const otherPrompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: other?.updates,
        workerUpdates: other?.workerUpdates, transformedUserText: '' });
      expect(otherPrompt).not.toContain('Which region?');
      completed = true;
      expect(await prepared!.recheckAdmission(new AbortController().signal)).toBe(false);
      const settled = await prepare();
      expect(settled).toMatchObject({ updates: [], withdrawnFollowLocalInputIds: ['question-input'] });
      expect(settled?.representedFollowLocalInputIds).toBeUndefined();
    } finally { material.dispose(); }
  });

  it.each(['goal_changed', 'message'] as const)('composes an admitted %s original and ACKs only its exact accepted input', async kind => {
    const delivered = { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 0, turn: null };
    const observed = { ...delivered, transcriptSeq: 1 };
    const localInputId = 'admitted-original';
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: kind === 'goal_changed' ? 'wake' : 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'source-original', seq: 1 } }, event: { kind } });
    const acknowledgeSessionFollow = vi.fn(async (_request: unknown) => ({
      ok: true as const, v: 1 as const, destinationSessionId: 'destination', sourceSessionId: 'source', delivered: observed,
    }));
    // Socket observation/ACK and source HTTP are boundaries; hydration,
    // selection, composition and acceptance custody execute their real owners.
    const session = createMutableApiSessionClientFixture({ sessionId: 'destination', overrides: {
      runSessionFollowSourceRequest: ({ request }) => request(),
      observePendingSessionFollow: async () => ({
        ok: true, v: 1, sessionId: 'destination', publisherGeneration: '7', currentSourceSessionIds: ['source'],
        observations: [{ kind: 'admitted_input', localInputId, sourceSessionId: 'source', destinationSessionId: 'destination',
          delivered, observed, delivery, effectiveDelivery: delivery.delivery }],
      }),
      acknowledgeSessionFollow,
      reconcileSessionInputForProviderDispatch: async () => 'admitted',
    } });
    const material = createSessionFollowSourceMaterialResolver();
    try {
      const hydrateObservation = createSessionFollowSourceHydrator({ session, credentials: { token: 'token', encryption: null },
        sourceMaterialResolver: material, deps: { fetchRunnerSourceProjection: async () =>
          SessionFollowSourceProjectionResponseV1Schema.parse({ v: 1,
            source: { id: 'source', encryptionMode: 'plain', metadata: '{}', archivedAt: null,
              createdAt: 1, updatedAt: 1, active: true, activeAt: 1, thinking: false, thinkingAt: null,
              latestTurnStatus: null, latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
              meaningfulActivityAt: null, agentStateVersion: 0 },
            messages: [{ seq: 1, localId: 'direction-original', createdAt: 1, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
              content: kind === 'goal_changed' ? { type: 'event', data: { type: 'goal-changed' } }
                : { type: 'codex', data: { type: 'message', message: 'Please review [Source](happier-ref:session:source)' } } } } }], hasMore: false,
          }),
        } });
      const reconciler = createSessionFollowContextReconciler({ session, hydrateObservation, maxFollowContextUtf8Bytes: 8192 });
      const prepared = await reconciler({ signal: new AbortController().signal,
        followDeliveries: [{ delivery, localInputId, userMessageSeq: 2 }] });
      expect(prepared?.representedFollowLocalInputIds).toEqual([localInputId]);
      expect(prepared?.wakeEventLocalId).toBeUndefined();
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      const prompt = renderSessionInputContextPromptV1({ sessionFollowUpdates: prepared!.updates,
        transformedUserText: 'ACTUAL_INPUT' });
      expect(prompt).toContain('<session_follow>');
      expect(prompt).toContain(kind === 'goal_changed' ? 'goal changed' : 'Please review');
      expect(prompt).not.toContain('happier-ref:');
      expect(prompt.endsWith('ACTUAL_INPUT')).toBe(true);
      prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId: 'another-input', userMessageSeq: 2 });
      expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      if (kind === 'message') {
        session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
        const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => mode.permissionMode,
          { batcher: combinePermissionModeQueuedPrompts });
        const token = '[Source](happier-ref:session:source)';
        queue.push({ text: `ACTUAL_INPUT ${token}`, localId: 'natural-input', userMessageSeq: 3,
          structuredInput: { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:source', token, label: 'Source' }] },
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' },
          followDeliveries: [{ delivery, localInputId, userMessageSeq: 2 }] }, { permissionMode: 'default' });
        let emitNative: ((event: AgentSessionRuntimeEvent) => void) | undefined;
        let sequence = 0;
        const sent: Array<{ text: string; inputIds: readonly string[] }> = [];
        // Only the external Agent and Session persistence/HTTP are boundaries.
        // Native correlation, prompt preparation, Follow selection and acceptance are real.
        const native: AgentSessionRuntime = {
          send: async request => {
            sent.push({ text: request.input.text, inputIds: request.inputIds });
            if (request.delivery.kind !== 'newTurn') throw new Error('Expected natural newTurn');
            const turnId = request.delivery.turnId;
            emitNative?.({ kind: 'input-accepted', sessionId: 'destination', inputIds: request.inputIds,
              delivery: request.delivery, sequence: ++sequence, emittedAtMs: 1 });
            emitNative?.({ kind: 'turn-start', sessionId: 'destination', turnId, startedBy: 'host', sequence: ++sequence, emittedAtMs: 1 });
            queueMicrotask(() => emitNative?.({ kind: 'turn-complete', sessionId: 'destination', turnId,
              sequence: ++sequence, emittedAtMs: 2 }));
            return { status: 'admitted' };
          },
          watch: handler => { emitNative = handler; return { dispose: () => { emitNative = undefined; } }; },
          dispose: async () => undefined,
        };
        const signal = new AbortController().signal;
        const runtime = createNativeAgentSessionOperations(native, 'destination', undefined, undefined, undefined,
          undefined, undefined, {
            // The selected newTurn-only external fixture consumes only cancellation.
            context: { signal } as AgentSessionRuntimeContext, cwd: '/tmp', connectedAccounts: [],
            capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
          });
        const settled: string[] = [];
        const binding = createSessionProviderInputOutcomeBinding({
          getTarget: () => ({ sessionId: 'destination', hasPendingProviderInput: id => id === localInputId || id === 'natural-input',
            observeProviderInputSettlement: async outcome => { if (outcome.kind === 'accepted') settled.push(outcome.localId); } }),
        });
        const unbind = bindSessionProviderInputOutcome({ runtime, observe: binding.observeProviderInputOutcome, wakePendingMaterialization() {} });
        const permission = createProviderEnforcedPermissionHandler({ session, logPrefix: '[quiet Follow composition]' });
        const failures: unknown[] = [];
        let done = false;
        try {
          await runPermissionModePromptLoop({ providerName: 'External Agent', agentMessageType: 'qwen',
            explicitPermissionMode: undefined, session, messageQueue: queue, permissionHandler: permission, runtime,
            createOverrideSynchronizer: isStarted => createRuntimeOverrideSynchronizers({
              agentTargetKey: 'agent:happier.agent.codex/codex', session, isStarted,
              runtime: {
                setSessionMode: modeId => runtime.updateSessionRuntimeConfig({ modeId }),
                setSessionConfigOption: (id, value) => runtime.updateSessionRuntimeConfig({ configOption: { id, value } }),
                setSessionModelSelection: async selection => { await runtime.updateSessionRuntimeConfig({ modelId: selection.modelId }); },
              },
            }),
            messageBuffer: new MessageBuffer(), shouldExit: () => done, getAbortSignal: () => signal,
            keepAlive() {}, setThinking() {}, sendReady() { done = true; }, currentPermissionModeUpdatedAt: 0,
            setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {}, formatPromptErrorMessage: String,
            onPromptFailure: async error => {
              failures.push(error);
              done = true;
              // Release the fixture's real pending-turn wait after a pre-send
              // correlation refusal; do not mistake a cleanup timeout for RED.
              await runtime.resetOrDisposeRuntime();
            },
            prepareHostContext: input => reconciler(input),
            registerProviderAcceptedEffect: binding.registerProviderAcceptedEffect,
          });
          expect(failures).toEqual([]);
          expect(sent).toHaveLength(1);
          expect(sent[0]?.inputIds).toEqual(['natural-input']);
          expect(sent[0]?.text).toContain('Please review');
          expect(sent[0]?.text).toContain('ACTUAL_INPUT @Session "Source"');
          expect(sent[0]?.text).not.toContain('happier-ref:');
          await vi.waitFor(() => expect(settled).toEqual([localInputId, 'natural-input']));
        } finally {
          unbind();
          binding.clearAcceptedEffects();
          await runtime.resetOrDisposeRuntime();
          await permission.reset();
        }
      } else prepared!.acknowledgeAccepted({ kind: 'admitted_input', localInputId, userMessageSeq: 2 });
      await vi.waitFor(() => expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
        localInputId, sourceSessionId: 'source', expected: delivered, consumed: observed,
        acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: 2 },
      })));
    } finally { material.dispose(); }
  });
});
