import { describe, expect, it, vi } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SessionInputAdmissionReceiptV1Schema, settleSessionInputRequestV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createMutableApiSessionClientFixture, createSessionRecordFixture, createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { UserMessage } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { createSessionFollowContextReconciler } from './session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from './session/follow/sessionFollowSourceHydrator';
import { createSessionFollowSourceMaterialResolver } from './session/follow/sessionFollowSourceMaterialResolver';
import { runPermissionModePromptLoop } from './runPermissionModePromptLoop';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import type { RuntimeTurnPromptMeta } from './turns/runtimeTurnOperations';
import { createPermissionModeQueueState } from './createPermissionModeQueueState';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionProviderInputOutcomeBinding, type SessionProviderInputOutcome } from './session/input/providerInputOutcome';
import { composeExecutionRunWorkerUpdateV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

function createFollowHarness(overrides?: Omit<Partial<ApiSessionClient>, 'updateMetadata'>) {
  let emit: ((message: UserMessage) => boolean | void) | undefined;
  const steerText = vi.fn(async () => undefined);
  const queuedDuringTurn = vi.fn();
  const session = createMutableApiSessionClientFixture({
    sessionId: 'destination', metadata: createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }),
    overrides: {
      ...overrides,
      onUserMessage: handler => { emit = handler; },
      getCommittedUserMessageSeq: localId => localId === 'follow-input' ? 17 : localId === 'follow-second' ? 19 : 18,
    },
  });
  let busy = false;
  const state = createPermissionModeQueueState({
    session, agentTargetKey: 'agent:happier.agent.codex/codex', initialPermissionMode: 'default',
    inFlightSteer: { isTurnInFlight: () => busy, supportsInFlightSteer: () => true,
      steerText, registerProviderAcceptedEffect: () => undefined, onPromptQueuedDuringTurn: queuedDuringTurn },
  });
  const delivery = (preset: 'important' | 'everything', seq = 4) => SessionFollowInputV1Schema.parse({
    v: 1, delivery: preset === 'important' ? 'next_turn' : 'wake',
    original: { sourceSessionId: 'source', sourceMessage: { localId: `source-occurrence-${seq}`, seq } }, event: { kind: 'update_posted' },
  });
  const emitDelivery = (followDeliveryV1: ReturnType<typeof delivery>, includeReceipt = true, localId = 'follow-input', accountReceipt = false) => {
    const inputAdmissionReceipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, followDeliveryV1,
      ...(accountReceipt ? { issuer: 'authenticatedAccount', actorAccountId: 'account', sessionRelationship: 'owner' }
        : { issuer: 'authenticatedMachine' }),
      admittedTarget: { homeId: 'home', accountId: 'account', sessionId: 'destination',
        machineId: 'destination-machine', installationId: 'destination-installation' } });
    const authority = settleSessionInputRequestV1({ request: { v: 1, producer: 'sessionAction', permission: {}, followDeliveryV1 },
      currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
    if (!emit) throw new Error('missing user input binding');
    emit({ role: 'user', content: { type: 'text', text: '/clear' }, localId,
      inputAdmissionReceipt: includeReceipt ? inputAdmissionReceipt : undefined, meta: withSessionInputAuthorityV1({}, authority) });
    return followDeliveryV1;
  };
  return { ...state, session, steerText, queuedDuringTurn, setBusy: (next: boolean) => { busy = next; },
    emit: (message: UserMessage) => { if (!emit) throw new Error('missing user input binding'); return emit(message); },
    emitDelivery,
    emitFollow: (preset: 'important' | 'everything', includeReceipt = true, localId = 'follow-input', seq = 4, accountReceipt = false) => {
      const followDeliveryV1 = delivery(preset, seq);
      return emitDelivery(followDeliveryV1, includeReceipt, localId, accountReceipt);
    },
  };
}

describe('protected Follow queue intake', () => {
  it('adopts the published Session permission and its timestamp together before resumed input', async () => {
    let receive: ((message: UserMessage) => boolean | void) | undefined;
    const session = createMutableApiSessionClientFixture({ sessionId: 'resumed-session',
      metadata: createTestMetadata({ permissionMode: 'read-only', permissionModeUpdatedAt: 300 }),
      overrides: { onUserMessage: handler => { receive = handler; } },
    });
    const state = createPermissionModeQueueState({ session, agentTargetKey: 'agent:happier.agent.codex/codex',
      initialPermissionMode: 'default' });
    const emit = (message: UserMessage) => {
      if (!receive) throw new Error('Missing input transport');
      return receive(message);
    };
    try {
      expect({ mode: state.getCurrentPermissionMode(), updatedAt: state.getCurrentPermissionModeUpdatedAt() })
        .toEqual({ mode: 'read-only', updatedAt: 300 });
      emit({ role: 'user', localId: 'resumed-input', content: { type: 'text', text: 'continue' }, meta: {} });
      const batch = await state.messageQueue.waitForMessagesAndGetAsString();
      expect(batch?.mode.permissionMode).toBe('read-only');
    } finally { state.messageQueue.close(); }
  });

  it('refuses a Follow marker without the actual native admission receipt', () => {
    const harness = createFollowHarness();
    harness.emitFollow('everything', false);
    expect(harness.messageQueue.queue).toEqual([]);
    expect(harness.steerText).not.toHaveBeenCalled();
  });
  it('retains quiet Follow for the next real input with its original admission identity', async () => {
    const harness = createFollowHarness();
    const follow = harness.emitFollow('important');
    expect(harness.messageQueue.size()).toBe(0);
    expect(harness.messageQueue.queue).toHaveLength(1);
    harness.emit({ role: 'user', content: { type: 'text', text: 'continue work' }, localId: 'human-input', meta: {} });
    const batch = await harness.messageQueue.waitForMessagesAndGetAsString();
    expect(batch?.message).toMatchObject({ text: 'continue work', localId: 'human-input', localIds: ['human-input'],
      followDeliveries: [{ delivery: follow, localInputId: 'follow-input', userMessageSeq: 17 }] });
    expect(harness.steerText).not.toHaveBeenCalled();
  });

  it('queues a wake behind a busy turn without steering or executing Follow text as a command', async () => {
    const harness = createFollowHarness();
    harness.messageQueue.push({ text: 'already queued', localId: 'queued-first' }, { permissionMode: 'default' });
    harness.setBusy(true);
    const follow = harness.emitFollow('everything');
    await Promise.resolve();
    expect(harness.messageQueue.size()).toBe(2);
    expect(harness.messageQueue.queue[0].message.text).toBe('already queued');
    expect(harness.messageQueue.queue[1].message).toMatchObject({
      followDeliveries: [{ delivery: follow, localInputId: 'follow-input', userMessageSeq: 17 }],
    });
    expect(harness.steerText).not.toHaveBeenCalled();
    expect(harness.queuedDuringTurn).toHaveBeenCalledOnce();
  });
});

describe('protected Follow queue to host context', () => {
  it.each(['represented', 'account-receipt', 'two-originals', 'selected-prefix-gap', 'selected-prefix-one-fits', 'omitted', 'wake', 'withdrawn', 'local-command',
    'request-live-after-version-change', 'request-live-encrypted', 'request-answered', 'request-replaced',
    'request-other-turn', 'request-withdrawn', 'request-sidechain', 'request-answered-at-dispatch', 'run-execution', 'run-workflow',
    'run-execution-quiet', 'run-workflow-quiet', 'run-execution-withdrawn', 'run-execution-permission',
    'run-execution-permission-withdrawn', 'run-execution-permission-withdrawn-at-dispatch',
    'run-execution-permission-withdrawn-quiet'] as const)('keeps exact accepted-input custody when Follow is %s', async (scenario) => {
    const observePendingSessionFollow = vi.fn<ApiSessionClient['observePendingSessionFollow']>(async () => ({
      ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', currentSourceSessionIds: [], observations: [],
    }));
    const acknowledgeSessionFollow = vi.fn<ApiSessionClient['acknowledgeSessionFollow']>(async input => ({
      ok: true, v: 1, destinationSessionId: 'destination', ...('original' in input
        ? { localInputId: input.localInputId, original: input.original }
        : { sourceSessionId: input.sourceSessionId, delivered: input.consumed }),
    }));
    const settlements: SessionProviderInputOutcome[] = [];
    const withdrawals: string[] = [];
    let finished = false;
    const harness = createFollowHarness({ observePendingSessionFollow, acknowledgeSessionFollow,
      runSessionFollowSourceRequest: ({ request }) => request(),
      enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false }),
      reconcileSessionInputForProviderDispatch: async () => 'admitted',
      // Home cancellation is an RPC boundary; the real Follow and prompt-loop owners decide when to call it.
      withdrawSessionInputBeforeProviderDispatch: async ({ localId }) => {
        withdrawals.push(localId);
        finished = true;
        return true;
      },
      observeProviderInputSettlement: async input => { settlements.push(input); return true; },
    });
    const requestScenario = scenario.startsWith('request-');
    const runScenario = scenario.startsWith('run-');
    const runPermission = scenario.startsWith('run-execution-permission');
    let runPermissionCleared = scenario === 'run-execution-permission-withdrawn' || scenario === 'run-execution-permission-withdrawn-quiet';
    const refused = scenario === 'withdrawn' || scenario === 'run-execution-withdrawn' || scenario === 'request-answered' || scenario === 'request-replaced'
      || scenario === 'request-other-turn' || scenario === 'request-withdrawn' || scenario === 'request-sidechain'
      || scenario === 'request-answered-at-dispatch' || scenario === 'run-execution-permission-withdrawn'
      || scenario === 'run-execution-permission-withdrawn-at-dispatch';
    const standalone = scenario === 'wake' || scenario === 'withdrawn' || requestScenario || runScenario && !scenario.endsWith('-quiet');
    const follow = runScenario ? harness.emitDelivery(SessionFollowInputV1Schema.parse({ v: 1, delivery: scenario.endsWith('-quiet') ? 'next_turn' : 'wake',
      original: runPermission ? { source: { kind: 'execution_run', sessionId: 'source', runId: 'run-original' }, permissionRequests: [{ requestId: 'run-permission', createdAt: 1 }] }
        : scenario.startsWith('run-execution') ? { source: { kind: 'execution_run', sessionId: 'source', runId: 'run-original' }, terminalEventId: 'terminal-original' }
        : { source: { kind: 'workflow_run', runId: 'run-original' }, revision: 4 },
      event: runPermission ? { kind: 'needs_you', type: 'approval' } : { kind: 'failed_or_stopped' } }))
      : requestScenario ? harness.emitDelivery(SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake',
      original: { sourceSessionId: 'source', sourceRequests: { agentStateVersion: 4,
        requests: [{ requestId: 'question', createdAt: 3, turnId: 'source-turn' }] } },
      requestEvents: [{ requestId: 'question', event: { kind: 'needs_you', type: 'decision' } }] }))
      : harness.emitFollow(standalone ? 'everything' : 'important', true, 'follow-input', 4, scenario === 'account-receipt');
    const second = scenario === 'two-originals' || scenario === 'selected-prefix-gap' || scenario === 'selected-prefix-one-fits'
      ? harness.emitFollow('important', true, 'follow-second', 5) : null;
    observePendingSessionFollow.mockImplementation(async () => ({ ok: true, v: 1, sessionId: 'destination', publisherGeneration: '1', currentSourceSessionIds: ['source'],
      observations: scenario === 'withdrawn' || scenario === 'run-execution-withdrawn' ? [] : [...[{ localInputId: 'follow-input', delivery: follow },
        ...(second ? [{ localInputId: 'follow-second', delivery: second }] : [])].map(({ localInputId, delivery }) => {
        if ('source' in delivery.original) return { kind: 'admitted_run_input' as const, localInputId,
          destinationSessionId: 'destination', delivery, effectiveDelivery: delivery.delivery,
          ...('terminalEventId' in delivery.original ? { workerUpdate: composeExecutionRunWorkerUpdateV1({
            runId: 'run-original', sessionId: 'source', status: 'failed', canInspect: true,
          }) } : {}),
          ...(runPermissionCleared ? { disposition: 'withdrawn' as const } : {}) };
        if (!('sourceMessage' in delivery.original)) return { kind: 'admitted_input' as const, localInputId,
          sourceSessionId: 'source', destinationSessionId: 'destination', delivery, effectiveDelivery: delivery.delivery,
          delivered: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 3, turn: null },
          observed: { transcriptSeq: 0, readyEventSeq: 0, agentStateVersion: 4, turn: null } };
        return { kind: 'admitted_input' as const, localInputId, sourceSessionId: 'source', destinationSessionId: 'destination', delivery, effectiveDelivery: delivery.delivery,
          delivered: { transcriptSeq: delivery.original.sourceMessage.seq - 1, readyEventSeq: 0, agentStateVersion: 0, turn: null },
          observed: { transcriptSeq: delivery.original.sourceMessage.seq, readyEventSeq: 0, agentStateVersion: 0, turn: null } };
      }), ...(scenario === 'two-originals' ? [{ sourceSessionId: 'source', destinationSessionId: 'destination',
        relation: 'manager' as const, attachedAt: 1, policy: { preset: 'important' as const },
        delivered: { transcriptSeq: 3, readyEventSeq: 0, agentStateVersion: 0, turn: null },
        observed: { transcriptSeq: 6, readyEventSeq: 0, agentStateVersion: 0, turn: { id: 'later-turn', status: 'completed' as const } },
      }] : [])],
    }));
    if (!standalone) harness.emit({ role: 'user', content: { type: 'text', text: scenario === 'local-command' ? '/clear' : 'continue work' }, localId: 'human-input', meta: {} });
    const material = createSessionFollowSourceMaterialResolver();
    let requestAnsweredAfterPreparation = false;
    const requestContext = { encryptionKey: new Uint8Array(32).fill(29), encryptionVariant: 'dataKey' as const };
    const encryptedRequest = scenario === 'request-live-encrypted';
    if (encryptedRequest) material.installPreparedDataKey({ sourceSessionId: 'source', dataKey: requestContext.encryptionKey });
    const currentState = { requests: scenario === 'request-withdrawn' ? {} : { question: {
      tool: 'AskUserQuestion', arguments: {}, kind: 'user_action', createdAt: scenario === 'request-replaced' ? 9 : 3,
      turnId: scenario === 'request-other-turn' ? 'other-turn' : 'source-turn',
      ...(scenario === 'request-sidechain' ? { sidechainId: 'child-run' } : {}),
    } }, completedRequests: scenario === 'request-answered' ? { question: { tool: 'AskUserQuestion', arguments: {},
      createdAt: 3, completedAt: 8, turnId: 'source-turn', status: 'approved' } } : {} };
    const answeredState = { ...currentState, completedRequests: { question: {
      tool: 'AskUserQuestion', arguments: {}, createdAt: 3, completedAt: 8, turnId: 'source-turn', status: 'approved',
    } } };
    const hydrate = createSessionFollowSourceHydrator({ session: harness.session, credentials: { token: 'token', encryption: null },
      sourceMaterialResolver: material,
      deps: { ...(requestScenario && !encryptedRequest ? { resolveSourceTransport: async () => ({ ok: true as const, sessionId: 'source', mode: 'plain' as const, ctx: null,
        accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(), rawSession: createSessionRecordFixture({
          id: 'source', encryptionMode: 'plain', metadata: JSON.stringify(createTestMetadata()),
          agentStateVersion: requestAnsweredAfterPreparation ? 8 : 7,
          pendingUserActionRequestCount: 1, pendingPermissionRequestCount: 0,
          agentState: JSON.stringify(requestAnsweredAfterPreparation ? answeredState : currentState),
        }) }) } : {}), fetchRunnerSourceProjection: async ({ sourceSessionId, afterTranscriptSeq, observedTranscriptSeq }) => SessionFollowSourceProjectionResponseV1Schema.parse({
        v: 1, source: { id: sourceSessionId, encryptionMode: encryptedRequest ? 'e2ee' : 'plain',
          metadata: encryptedRequest ? encryptSessionPayload({ ctx: requestContext, payload: { path: '/project', host: 'source-host' } })
            : JSON.stringify({ path: '/project', host: 'source-host' }),
          archivedAt: null, createdAt: 1, updatedAt: Date.now(), active: true, activeAt: Date.now(), thinking: false, thinkingAt: null,
          latestTurnStatus: scenario === 'two-originals' ? 'completed' : null,
          latestTurnId: scenario === 'two-originals' ? 'later-turn' : null,
          latestTurnStatusObservedAt: null, latestReadyEventSeq: null, latestReadyEventAt: null,
          meaningfulActivityAt: null, agentStateVersion: requestScenario ? 7 : 0,
          ...(requestScenario ? { agentState: encryptedRequest ? encryptSessionPayload({ ctx: requestContext, payload: currentState })
            : JSON.stringify(currentState) } : {}) },
        messages: requestScenario ? [] : (scenario === 'two-originals'
          ? [4, 5, 6].filter(seq => seq > afterTranscriptSeq && seq <= observedTranscriptSeq)
          : [observedTranscriptSeq]).map(observedTranscriptSeq => ({ seq: observedTranscriptSeq,
          localId: scenario === 'two-originals' && observedTranscriptSeq === 6 ? null : `source-original-${observedTranscriptSeq}`,
          createdAt: observedTranscriptSeq,
          content: { t: 'plain', v: { role: 'agent', content: scenario === 'two-originals' && observedTranscriptSeq === 6
            ? { type: 'codex', data: { type: 'message', message: 'Later terminal-only outcome' } }
            : scenario === 'two-originals'
            ? { type: 'event', id: `report-${observedTranscriptSeq}`, data: { type: 'worker-report',
              summary: `retained source update ${observedTranscriptSeq}`,
              deliverables: [{ kind: 'workspace_file', sessionId: 'source', path: `report-${observedTranscriptSeq}.md` }] } }
            : { type: 'text',
            text: scenario === 'selected-prefix-gap' && observedTranscriptSeq === 4
              ? `earlier selected original ${'x'.repeat(16_384)}` : `retained source update ${observedTranscriptSeq}${scenario === 'selected-prefix-one-fits' ? 'x'.repeat(3_000) : ''}` } } } })), hasMore: false,
      }) },
    });
    const reconcile = createSessionFollowContextReconciler({ session: harness.session, hydrateObservation: hydrate,
      maxFollowContextUtf8Bytes: scenario === 'omitted' ? 0 : scenario === 'selected-prefix-one-fits' ? 6_000 : 8192 });
    const binding = createSessionProviderInputOutcomeBinding({ getTarget: () => ({
      sessionId: harness.session.sessionId,
      hasPendingProviderInput: localId => ['human-input', 'follow-input', 'follow-second'].includes(localId),
      observeProviderInputSettlement: outcome => harness.session.observeProviderInputSettlement(outcome),
    }) });
    const sends: { prompt: string; meta?: RuntimeTurnPromptMeta }[] = [];
    const resets: unknown[] = [];
    try {
      await runPermissionModePromptLoop({
        providerName: 'Test Agent', agentMessageType: 'qwen', explicitPermissionMode: undefined,
        session: harness.session, messageQueue: harness.messageQueue,
        permissionHandler: { setPermissionMode: () => undefined, reset: () => undefined },
        runtime: {
          beginTurnLifecycle: () => undefined,
          sendTurnPrompt: async (prompt, meta) => {
            sends.push({ prompt, meta });
            if (!meta?.localId) throw new Error('Missing native primary input identity');
            const accepted = { type: 'input-accepted' as const, localInputId: meta.localId,
              userMessageSeq: meta.userMessageSeq ?? null, userMessageSeqs: meta.userMessageSeqs,
              delivery: { kind: 'newTurn' as const, turnId: 'native-turn' } };
            binding.observeProviderInputOutcome(accepted);
            binding.observeProviderInputOutcome(accepted);
            if (scenario === 'represented') expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
          },
          steerInFlightTurn: async () => undefined, waitForTurnCompletion: async () => undefined,
          subscribeRuntimeEvents: () => () => undefined, cancelTurn: async () => undefined,
          readSessionIdentity: () => ({ sessionId: 'native-session' }), updateSessionRuntimeConfig: async () => undefined,
          resetOrDisposeRuntime: async (...args) => { resets.push(args); },
          prepareHostContext: async ({ signal, followDeliveries }) => {
            const prepared = await reconcile({ signal, followDeliveries });
            if (scenario === 'request-answered-at-dispatch') requestAnsweredAfterPreparation = true;
            if (scenario === 'run-execution-permission-withdrawn-at-dispatch') runPermissionCleared = true;
            return prepared;
          },
        },
        createOverrideSynchronizer: () => ({ syncFromMetadata: () => undefined, flushPendingAfterStart: async () => undefined }),
        messageBuffer: new MessageBuffer(), shouldExit: () => finished, getAbortSignal: () => new AbortController().signal,
        keepAlive: () => undefined, setThinking: () => undefined, sendReady: () => { finished = true; },
        currentPermissionModeUpdatedAt: 0, setCurrentPermissionMode: () => undefined, setCurrentPermissionModeUpdatedAt: () => undefined,
        registerProviderAcceptedEffect: binding.registerProviderAcceptedEffect, formatPromptErrorMessage: String,
      });
      expect(sends).toHaveLength(refused || scenario === 'local-command' ? 0 : 1);
      expect(resets).toHaveLength(scenario === 'local-command' ? 1 : 0);
      if (refused) {
        if (requestScenario || runPermissionCleared) {
          expect(withdrawals).toEqual(['follow-input']);
          expect(settlements).toEqual([]);
        } else {
          expect(withdrawals).toEqual([]);
          expect(settlements).toContainEqual(expect.objectContaining({ kind: 'rejected_before_effect', localId: 'follow-input',
            reason: 'provider_unavailable_before_acceptance', retryable: true }));
        }
        expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      } else if (scenario === 'omitted' || scenario === 'local-command' || scenario === 'selected-prefix-gap') {
        if (scenario === 'omitted' || scenario === 'selected-prefix-gap') {
          expect(sends[0].meta?.localIds).toEqual(['human-input']);
          expect(sends[0].prompt).not.toContain('retained source update');
        }
        expect(harness.messageQueue.size()).toBe(0);
        expect(harness.messageQueue.queue[0].message.followDeliveries).toEqual([{ delivery: follow, localInputId: 'follow-input', userMessageSeq: 17 }]);
        if (scenario === 'selected-prefix-gap') expect(harness.messageQueue.queue[1].message.followDeliveries)
          .toEqual([{ delivery: second, localInputId: 'follow-second', userMessageSeq: 19 }]);
        expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
      } else if (scenario === 'selected-prefix-one-fits') {
        expect(sends[0].meta?.localIds).toEqual(['human-input']);
        expect(sends[0].prompt).toContain('retained source update 4');
        expect(sends[0].prompt).not.toContain('retained source update 5');
        expect(harness.messageQueue.queue).toHaveLength(1);
        expect(harness.messageQueue.queue[0].message.followDeliveries)
          .toEqual([{ delivery: second, localInputId: 'follow-second', userMessageSeq: 19 }]);
        await vi.waitFor(() => expect(acknowledgeSessionFollow.mock.calls.map(([ack]) => ({ localInputId: 'localInputId' in ack ? ack.localInputId : null,
          consumedSeq: 'consumed' in ack ? ack.consumed.transcriptSeq : null }))).toEqual([{ localInputId: 'follow-input', consumedSeq: 4 }]));
      } else {
        if (scenario === 'run-execution-permission-withdrawn-quiet') {
          expect(sends[0].prompt).not.toContain('run-original');
          expect(withdrawals).toEqual(['follow-input']);
          expect(settlements).toEqual([expect.objectContaining({ kind: 'accepted', localId: 'human-input', userMessageSeq: 18,
            providerTurnId: 'native-turn', providerDeliveryKind: 'newTurn' })]);
          expect(acknowledgeSessionFollow).not.toHaveBeenCalled();
          expect(harness.messageQueue.queue).toEqual([]);
          return;
        }
        if (runScenario) expect(sends[0].prompt).toContain('run-original');
        else if (!requestScenario) expect(sends[0].prompt).toContain('retained source update');
        expect(sends[0].meta?.localIds).toEqual(standalone ? ['follow-input'] : ['human-input']);
        if (scenario === 'two-originals') {
          expect(sends[0].prompt).toContain('retained source update 5');
          expect(sends[0].prompt).toContain('report-4.md');
          expect(sends[0].prompt).toContain('report-5.md');
          expect(sends[0].prompt).not.toContain('Later terminal-only outcome');
        }
        expect(harness.messageQueue.queue).toEqual([]);
        await vi.waitFor(() => expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
          localInputId: 'follow-input',
          acceptance: expect.objectContaining({ localInputId: 'follow-input', userMessageSeq: 17 }),
        })));
        if (requestScenario) expect(acknowledgeSessionFollow).toHaveBeenCalledWith(expect.objectContaining({
          expected: expect.objectContaining({ agentStateVersion: 3 }),
          observed: expect.objectContaining({ agentStateVersion: 4 }),
          consumed: expect.objectContaining({ agentStateVersion: 4 }),
        }));
        for (const [ack] of acknowledgeSessionFollow.mock.calls) {
          expect(ack).not.toHaveProperty('rule');
          expect(ack).not.toHaveProperty('policy');
        }
        if (scenario === 'two-originals') {
          await vi.waitFor(() => expect(acknowledgeSessionFollow.mock.calls.map(([ack]) => ({ localInputId: 'localInputId' in ack ? ack.localInputId : null,
            consumedSeq: 'consumed' in ack ? ack.consumed.transcriptSeq : null }))).toEqual([
            { localInputId: 'follow-input', consumedSeq: 4 }, { localInputId: 'follow-second', consumedSeq: 5 },
          ]));
        }
      }
      const omitted = scenario === 'omitted' || scenario === 'selected-prefix-gap' || scenario === 'local-command';
      const expectedAcceptedIds = refused ? [] : standalone ? ['follow-input']
        : omitted ? ['human-input'] : scenario === 'two-originals'
          ? ['follow-input', 'follow-second', 'human-input'] : ['follow-input', 'human-input'];
      await vi.waitFor(() => expect(settlements.filter(outcome => outcome.kind === 'accepted')).toEqual(
        expectedAcceptedIds.map(localId => expect.objectContaining({ kind: 'accepted', localId,
          userMessageSeq: localId === 'follow-input' ? 17 : localId === 'follow-second' ? 19 : 18,
          ...(scenario === 'local-command' ? {} : { providerTurnId: 'native-turn', providerDeliveryKind: 'newTurn' }) })),
      ));
      if (scenario === 'local-command') expect(settlements[0]).not.toHaveProperty('providerTurnId');
      if (sends.length) expect(sends[0].meta).toMatchObject({
        localId: standalone ? 'follow-input' : 'human-input',
        userMessageSeq: standalone ? 17 : 18,
        userMessageSeqs: [standalone ? 17 : 18],
      });
    } finally { material.dispose(); }
  });
});
