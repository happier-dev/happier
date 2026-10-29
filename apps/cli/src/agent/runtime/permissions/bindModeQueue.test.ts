import { describe, expect, it, vi } from 'vitest';

import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { registerPermissionModeMessageQueueBinding } from './bindModeQueue';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import { appendNextTurnContextToQueuedPrompt, combinePermissionModeQueuedPrompts, isNextTurnContextQueuedPrompt } from '@/agent/runtime/permissions/queuedPrompt';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema, SessionInputRequestV2Schema, settleSessionInputRequestV1, settleSessionInputRequestV2,
  withSessionInputAuthorityV1, withSessionInputAuthority } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { formatFileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import { prepareSessionInputForProviderDispatch } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import {
  ProviderConnectionIdSchema,
  withParticipantRecipientV1,
  buildMentionRefForKindV1,
  MENTION_KIND_V1,
  type ProviderBoundModelRef,
} from '@happier-dev/protocol';

const LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK = `<happier_input_context v="1">
source_kind="legacyUnknown"
</happier_input_context>`;

describe('registerPermissionModeMessageQueueBinding', () => {
  it('keeps non-image upload metadata isolated through queue admission and final projection', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts,
    });
    const harness = createSessionHarness();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
    const attachment = { id: 'report', name: 'report.txt', path: '.happier/uploads/messages/input/report.txt', sizeBytes: 42 };
    const text = 'Read [report](happier-ref:attachment:report)';
    harness.emit({ role: 'user', localId: 'upload-input', content: { type: 'text', text },
      meta: { happier: { kind: 'attachments.v1', payload: { attachments: [attachment] } } } });
    harness.emit({ role: 'user', localId: 'following-input', content: { type: 'text', text: 'Then continue' }, meta: {} });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch?.message.localId).toBe('upload-input');
    expect(batch?.message.attachments).toEqual([attachment]);
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: batch!.message,
      transformedUserText: batch!.message.text, providerNativeCommand: false,
      signal: new AbortController().signal, localId: 'upload-input' });
    expect(prepared.requiredPrompt).toContain('Read [File: report.txt]');
    expect(prepared.requiredPrompt).not.toContain('happier-ref:');
    expect(prepared.requiredPrompt).not.toContain('Then continue');
    expect((await queue.waitForMessagesAndGetAsString())?.message.localId).toBe('following-input');
  });
  it.each([false, true])('retains file review notes until actual input without steering or waking (running=%s)', async running => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const harness = createSessionHarness();
    const steerText = vi.fn(async () => {});
    const onPromptQueuedDuringTurn = vi.fn();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {},
      inFlightSteer: { isTurnInFlight: () => running, supportsInFlightSteer: () => true,
        steerText, registerProviderAcceptedEffect() {}, onPromptQueuedDuringTurn },
    });
    for (const [index, action] of ['discard', 'restore', 'undo'].entries()) {
      harness.emit({ role: 'user', localId: `review-${index}`, content: { type: 'text', text: `File review ${action}` },
        inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', nextTurnNote: 'file_review_note.v1' },
        meta: { happier: { kind: 'file_review_note.v1', payload: { action, paths: ['src/app.ts'] } } } });
    }
    expect(queue.size()).toBe(0);
    expect(steerText).not.toHaveBeenCalled();
    expect(onPromptQueuedDuringTurn).not.toHaveBeenCalled();
    // Real input keeps its own provider witness; retained notes are descriptive context.
    queue.push({ text: 'Continue', localId: 'actual-input', userMessageSeq: 9 }, { permissionMode: 'default' });
    const batch = await queue.waitForMessagesAndGetAsString();
    expect(batch?.message.localIds).toEqual(['actual-input']);
    expect(batch?.message.userMessageSeq).toBe(9);
    expect(batch?.message.text).toBe('Continue');
    const prepared = await prepareSessionInputForProviderDispatch({ prompt: batch!.message, transformedUserText: batch!.message.text,
      providerNativeCommand: false, signal: new AbortController().signal, localId: 'actual-input' });
    for (const action of ['discard', 'restore', 'undo'] as const) {
      expect(prepared.renderPrompt().split(formatFileReviewNoteV1({ action, paths: ['src/app.ts'] }))).toHaveLength(2);
    }
    expect(prepared.renderPrompt()).not.toContain('File review discard');
  });

  it('rejects an unreceipted or malformed file review note before it can become input', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts, isContextOnly: isNextTurnContextQueuedPrompt,
      withContext: appendNextTurnContextToQueuedPrompt,
    });
    const harness = createSessionHarness();
    const rejectPromptBeforeProvider = vi.fn();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {},
      inFlightSteer: { isTurnInFlight: () => false, supportsInFlightSteer: () => false, steerText: async () => {},
        registerProviderAcceptedEffect() {}, rejectPromptBeforeProvider },
    });
    harness.emit({ role: 'user', localId: 'unreceipted', content: { type: 'text', text: 'Do not dispatch' },
      meta: { happier: { kind: 'file_review_note.v1', payload: { action: 'discard', paths: ['app.ts'] } } } });
    harness.emit({ role: 'user', localId: 'malformed', content: { type: 'text', text: 'Do not dispatch' },
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', nextTurnNote: 'file_review_note.v1' },
      meta: { happier: { kind: 'file_review_note.v1', payload: { action: 'keep', paths: ['app.ts'] } } } });
    expect(queue.size()).toBe(0);
    expect(rejectPromptBeforeProvider.mock.calls.map(([input]) => input.localIds)).toEqual([['unreceipted'], ['malformed']]);
  });

  it('keeps independently cancellable wake replies separate even with the same admitted cause', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(mode => JSON.stringify(mode), {
      batcher: combinePermissionModeQueuedPrompts,
    });
    const harness = createSessionHarness();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
    const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
      returnedAnswer: { requestSessionId: 'receiver', requestLocalId: 'question', outcome: 'answer', delivery: 'wake' } });
    const authority = settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' } });
    for (const localId of ['cancelled-reply', 'valid-reply']) harness.emit({ role: 'user', localId,
      content: { type: 'text', text: localId }, meta: withSessionInputAuthority({}, authority) });
    const first = await queue.waitForMessagesAndGetAsString();
    expect(first?.message).toMatchObject({ text: 'cancelled-reply', localIds: ['cancelled-reply'] });
    expect((await queue.waitForMessagesAndGetAsString())?.message).toMatchObject({ text: 'valid-reply', localIds: ['valid-reply'] });
  });

  it('keeps only public-safe matched reasons from the exact admitted Follow receipt on its queued original', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts,
    });
    const harness = createSessionHarness();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {} });
    const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn',
      original: { sourceSessionId: 'source', sourceMessage: { localId: 'source-original', seq: 2 } },
      event: { kind: 'update_posted' } });
    const inputAdmissionReceipt = { v: 1 as const, issuer: 'authenticatedMachine' as const,
      admittedTarget: { homeId: 'home', accountId: 'owner', sessionId: 'receiver', machineId: 'machine', installationId: 'installation' },
      followDeliveryV1: delivery,
      followRelations: [{ relation: 'manager' as const, attachedAt: 1 }, { relation: 'follower' as const }],
      followSources: [{ rule: { ruleId: 'private-rule', ruleVersion: 1 }, sourceSessionId: 'source',
        destinationSessionId: 'receiver', evaluation: 'receiver' as const, selectedDelivery: 'next_turn' as const,
        sourceMessage: { localId: 'source-original', seq: 2 } }],
    };
    const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
      followDeliveryV1: delivery });
    const authority = settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
    harness.emit({ role: 'user', content: { type: 'text', text: '' }, localId: 'follow-input', inputAdmissionReceipt,
      meta: withSessionInputAuthorityV1({}, authority) });
    const queued = await queue.waitForMessagesAndGetAsString();
    expect(queued?.message.followDeliveries).toEqual([{ delivery, localInputId: 'follow-input', userMessageSeq: null,
      followMatches: [{ kind: 'relation', relation: 'manager' }, { kind: 'relation', relation: 'follower' }, { kind: 'rule' }],
    }]);
    expect(JSON.stringify(queued)).not.toContain('private-rule');
  });

  it.each([1, 2] as const)('dequeues two admitted V%s Discussion questions as separate native prompts before a later peer answer', async version => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'same-provider-mode', {
      batcher: combinePermissionModeQueuedPrompts,
    });
    const harness = createSessionHarness();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {} });
    for (const [index, text] of ['first-question', 'second-question'].entries()) {
      const discussionAddressing = { discussionId: 'discussion', messageId: `question-${index}`, throughSeq: index + 2, participantSessionId: 'receiver' };
      const request = version === 1 ? SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
        discussionAddressing, replyIntent: { mode: 'return' } }) : SessionInputRequestV2Schema.parse({ v: 2,
        producer: 'workflow', caller: { kind: 'host' }, permission: {},
        workflow: { purpose: 'invocation', runId: 'workflow', invocationRecordId: `invocation-${index}` },
        discussionAddressing, replyIntent: { mode: 'wait' } });
      const inputAdmissionReceipt = { v: 1 as const, issuer: 'authenticatedMachine' as const, discussionAddressing,
        admittedTarget: { homeId: 'home', accountId: 'owner', sessionId: 'receiver', machineId: 'machine', installationId: 'installation' } };
      const authority = request.v === 1 ? settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt })
        : settleSessionInputRequestV2({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
      harness.emit({ role: 'user', content: { type: 'text', text }, localId: `input-${index}`, inputAdmissionReceipt,
        meta: withSessionInputAuthority({}, authority) });
    }
    harness.emit({ role: 'user', content: { type: 'text', text: 'later-peer-answer' }, localId: 'later', meta: {} });
    const first = await queue.waitForMessagesAndGetAsString();
    expect(first).toMatchObject({ isolate: true, message: { localId: 'input-0', discussionAddressing: { messageId: 'question-0', throughSeq: 2 } } });
    expect(first?.message.text).toContain('first-question');
    expect(first?.message.text).not.toContain('second-question');
    expect(first?.message.text).not.toContain('later-peer-answer');
    if (version === 1) expect(first?.message.inputContextBlock).not.toContain('reply_action=');
    else {
      expect(first?.message.inputContextBlock).toContain('reply_action="session.message.reply"');
      expect(first?.message.inputContextBlock).toContain('request_local_id="input-0"');
      expect(first?.message.inputContextBlock).toContain('reply_mode="wait"');
    }
    const second = await queue.waitForMessagesAndGetAsString();
    expect(second).toMatchObject({ isolate: true, message: { localId: 'input-1', discussionAddressing: { messageId: 'question-1', throughSeq: 3 } } });
    expect(second?.message.text).toContain('second-question');
    expect(second?.message.text).not.toContain('later-peer-answer');
    expect((await queue.waitForMessagesAndGetAsString())?.message.text).toContain('later-peer-answer');
  });
  it.each(['wait', 'return'] as const)('frames an admitted Session %s with its exact reply custody', async mode => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(() => 'mode', {
      batcher: combinePermissionModeQueuedPrompts,
    });
    const harness = createSessionHarness();
    registerPermissionModeMessageQueueBinding({ session: harness.session, queue,
      getCurrentPermissionMode: () => 'default', setCurrentPermissionMode() {} });
    const request = SessionInputRequestV1Schema.parse({ ...buildTrustedHostSessionInputAdmissionV1('agent').request,
      sourceSession: { sourceSessionId: 'asker', sourceTurnId: 'asker-turn', via: 'action' }, replyIntent: { mode } });
    const inputAdmissionReceipt = { v: 1 as const, issuer: 'authenticatedMachine' as const };
    const authority = settleSessionInputRequestV1({ request, currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
    harness.emit({ role: 'user', localId: 'exact-request', content: { type: 'text', text: 'Question' }, inputAdmissionReceipt,
      meta: withSessionInputAuthority({}, authority) });
    const queued = await queue.waitForMessagesAndGetAsString();
    expect(queued?.message.inputContextBlock).toContain('reply_action="session.message.reply"');
    expect(queued?.message.inputContextBlock).toContain('reply_session_id="receiver"');
    expect(queued?.message.inputContextBlock).toContain('request_local_id="exact-request"');
    expect(queued?.message.inputContextBlock).toContain(`reply_mode="${mode}"`);
  });

  it.each([
    { kind: 'agent_team_member' as const, teamId: 'team-a', memberId: 'member-a' },
    { kind: 'agent_team_broadcast' as const, teamId: 'team-a' },
  ])('refuses retained $kind input before config changes, steer or primary batching', async (recipient) => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    const harness = createSessionHarness();
    let current: PermissionMode | undefined = 'default';
    let inFlight = false;
    const rejected = vi.fn();
    const steerText = vi.fn(async () => {});
    registerPermissionModeMessageQueueBinding({
      session: harness.session, queue,
      getCurrentPermissionMode: () => current,
      setCurrentPermissionMode: (mode) => { current = mode; },
      inFlightSteer: { isTurnInFlight: () => inFlight, supportsInFlightSteer: () => true,
        steerText, registerProviderAcceptedEffect: () => {}, rejectPromptBeforeProvider: rejected },
    });
    harness.emit({ role: 'user', content: { type: 'text', text: 'primary before' }, localId: 'primary-before', meta: {} });
    for (const busy of [false, true]) {
      inFlight = busy;
      harness.emit({ role: 'user', content: { type: 'text', text: 'native-only secret' }, localId: `native-${busy}`,
        meta: withParticipantRecipientV1({ permissionMode: 'bypassPermissions' }, recipient) });
    }
    inFlight = false;
    harness.emit({ role: 'user', content: { type: 'text', text: 'primary after' }, localId: 'primary-after', meta: {} });
    expect(current).toBe('default');
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(rejected.mock.calls.map(([info]) => info)).toMatchObject([
      { localIds: ['native-false'], reason: 'unsupported_action' },
      { localIds: ['native-true'], reason: 'unsupported_action' },
    ]);
    expect((await queue.waitForMessagesAndGetAsString())?.message).toMatchObject({
      text: 'primary before\nprimary after', localIds: ['primary-before', 'primary-after'],
    });
    expect(steerText).not.toHaveBeenCalled();
  });

  it('rejects a restricted mode before metadata mutation and preserves unrestricted input', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    const harness = createSessionHarness();
    let current: PermissionMode | undefined = 'default';
    const rejected = vi.fn();
    registerPermissionModeMessageQueueBinding({
      session: harness.session,
      queue,
      getCurrentPermissionMode: () => current,
      setCurrentPermissionMode: (mode) => { current = mode; },
      inFlightSteer: { isTurnInFlight: () => false, supportsInFlightSteer: () => false,
        steerText: async () => {}, registerProviderAcceptedEffect: () => {}, rejectPromptBeforeProvider: rejected },
    });
    harness.emit({ role: 'user', content: { type: 'text', text: 'restricted' }, localId: 'restricted',
      meta: { permissionMode: 'bypassPermissions' },
      callerInputConstraints: { models: null, permissionModes: ['default'] },
    });
    expect(current).toBe('default');
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(queue.size()).toBe(0);
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
      localIds: ['restricted'], reason: 'permission_mode_not_granted',
    }));
    harness.emit({ role: 'user', content: { type: 'text', text: 'unrestricted' }, localId: 'unrestricted',
      meta: { permissionMode: 'bypassPermissions' },
    });
    expect((await queue.waitForMessagesAndGetAsString())?.mode.permissionMode).toBe('yolo');
  });

  it('rechecks the effective model before in-flight steer and does not constrain the next caller', async () => {
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>((mode) => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    const harness = createSessionHarness();
    const modelA: ProviderBoundModelRef = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'A' };
    let active = modelA;
    const rejected = vi.fn();
    const steerText = vi.fn(async () => {});
    registerPermissionModeMessageQueueBinding({
      session: harness.session,
      agentTargetKey: modelA.agentTargetKey,
      queue, getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {},
      inFlightSteer: { readActiveModelSelection: () => active, isTurnInFlight: () => true,
        supportsInFlightSteer: () => true, steerText, registerProviderAcceptedEffect: () => {}, rejectPromptBeforeProvider: rejected,
      },
    });
    harness.emit({ role: 'user', content: { type: 'text', text: 'restricted' }, localId: 'restricted', meta: {},
      callerInputConstraints: { models: [modelA], permissionModes: null },
    });
    active = { ...modelA, modelId: 'B' };
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(expect.objectContaining({
      localIds: ['restricted'], reason: 'model_not_granted',
    })));
    expect(steerText).not.toHaveBeenCalled();
    harness.emit({ role: 'user', content: { type: 'text', text: 'unrestricted' }, localId: 'unrestricted', meta: {} });
    await vi.waitFor(() => expect(steerText).toHaveBeenCalledWith(expect.stringContaining('unrestricted'), expect.anything()));
  });

  function createSessionHarness(initialMetadata?: Metadata) {
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    let metadata =
      initialMetadata ?? ({ permissionMode: 'default', permissionModeUpdatedAt: 0 } as unknown as Metadata);

    return {
      session: {
        sessionId: 'receiver',
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: (updater: (current: Metadata) => Metadata) => {
          metadata = updater(metadata);
        },
      },
      emit: (message: UserMessage) => {
        if (!userMessageHandler) throw new Error('missing onUserMessage handler');
        return userMessageHandler(message);
      },
      getMetadata: () => metadata,
    };
  }

  function createHarness(activeSelection: ProviderBoundModelRef = {
    agentTargetKey: 'agent:happier.agent.opencode/opencode',
    providerConnectionId: null,
    modelId: 'default',
  }) {
    const queueCalls: Array<{
      type: 'push' | 'isolate' | 'clear';
      message: PermissionModeQueuedPrompt;
      mode: PermissionModeQueuedPromptMode;
    }> = [];
    let currentPermissionMode: PermissionMode | undefined;
    const sessionHarness = createSessionHarness();
    const rejectPromptBeforeProvider = vi.fn();

    const binding = registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'push', message, mode }),
        pushIsolate: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'isolate', message, mode }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt, mode: PermissionModeQueuedPromptMode) =>
          queueCalls.push({ type: 'clear', message, mode }),
      },
      getCurrentPermissionMode: () => currentPermissionMode,
      setCurrentPermissionMode: (mode: PermissionMode | undefined) => {
        currentPermissionMode = mode;
      },
      inFlightSteer: {
        readActiveModelSelection: () => activeSelection,
        supportsInFlightSteer: () => false,
        isTurnInFlight: () => false,
        steerText: async () => undefined,
        rejectPromptBeforeProvider,
        registerProviderAcceptedEffect: () => undefined,
      },
    });

    return {
      bindSession: binding.bindSession,
      releaseRejectedBeforeProviderPromptIdentity: (binding as {
        releaseRejectedBeforeProviderPromptIdentity: (
          session: typeof sessionHarness.session,
          message: PermissionModeQueuedPrompt,
        ) => void;
      }).releaseRejectedBeforeProviderPromptIdentity,
      emit: sessionHarness.emit,
      session: sessionHarness.session,
      getCurrentPermissionMode: () => currentPermissionMode,
      getMetadata: sessionHarness.getMetadata,
      queueCalls,
      rejectPromptBeforeProvider,
    };
  }

  it('queues regular messages with the current permission mode', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-1',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'hello world',
          localId: 'local-1',
          localIds: ['local-1'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'default',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it('releases only the active binding identity after a proven pre-provider rejection', () => {
    const harness = createHarness();
    const localId = 'local-retry-after-pre-effect-rejection';
    const retry = {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'retry this exact pending input' },
      localId,
      meta: {},
    } as UserMessage;

    harness.emit(retry);
    harness.emit(retry);
    expect(harness.queueCalls).toHaveLength(1);

    harness.releaseRejectedBeforeProviderPromptIdentity({
      sessionId: 'other-receiver',
      onUserMessage: () => undefined,
      updateMetadata: () => undefined,
    }, {
      text: retry.content.text,
      localId,
      localIds: [localId],
    });
    harness.emit(retry);
    expect(harness.queueCalls).toHaveLength(1);

    harness.releaseRejectedBeforeProviderPromptIdentity(harness.session, {
      text: retry.content.text,
      localId,
      localIds: [localId],
    });
    harness.emit(retry);

    expect(harness.queueCalls).toMatchObject([
      { type: 'push', message: { localId } },
      { type: 'push', message: { localId } },
    ]);
  });

  it('releases the exact local id and committed sequence after durable pre-provider retirement', () => {
    const localId = 'local-retry-with-seq';
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    const session = {
      sessionId: 'receiver',
      onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
        userMessageHandler = handler;
      },
      updateMetadata: () => undefined,
      getCommittedUserMessageSeq: (candidateLocalId: string) => candidateLocalId === localId ? 42 : null,
    };
    const binding = registerPermissionModeMessageQueueBinding({
      session,
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => undefined,
    });
    const retry = {
      role: 'user' as const,
      content: { type: 'text' as const, text: 'retry only after custody retirement' },
      localId,
      meta: {},
    } as UserMessage;

    expect(userMessageHandler!(retry)).toBe(true);
    expect(userMessageHandler!(retry)).toBe(true);
    expect(queueCalls).toHaveLength(1);

    binding.releaseRejectedBeforeProviderPromptIdentity(session, {
      text: retry.content.text,
      localId,
      localIds: [localId],
      userMessageSeq: 42,
      userMessageSeqs: [42],
    });

    expect(userMessageHandler!(retry)).toBe(true);
    expect(queueCalls).toHaveLength(2);
  });

  it('preserves canonical image input through structured steer', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: Array<{ type: 'push' | 'isolate' | 'clear'; message: PermissionModeQueuedPrompt }> = [];
    const steerText = vi.fn(async (_text: string, _meta?: unknown) => undefined);
    const structuredInput = {
      v: 1 as const,
      imageInputs: [{
        id: 'image-1',
        kind: 'localImage' as const,
        path: '.happier/uploads/messages/message-1/image.png',
        mimeType: 'image/png',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
        provenance: { kind: 'sessionAttachmentUpload' as const },
      }],
    };

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'push', message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'isolate', message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'clear', message }),
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText,
        registerProviderAcceptedEffect: () => undefined,
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this image' },
      localId: 'local-image-1',
      meta: {
        happierStructuredInputV1: structuredInput,
      },
    } as UserMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(queueCalls).toEqual([]);
    expect(steerText.mock.calls[0]?.[1]).toMatchObject({ localId: 'local-image-1',
      structuredInput: { v: 1, imageInputs: [{ id: 'image-1', kind: 'localImage',
        path: '.happier/uploads/messages/message-1/image.png', mimeType: 'image/png' }] } });
  });

  it('renders a Session reference in structured steer', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: Array<{ type: 'push' | 'isolate' | 'clear'; message: PermissionModeQueuedPrompt }> = [];
    const steerText = vi.fn(async (_text: string, _meta?: unknown) => undefined);
    const structuredInput = {
      v: 1 as const,
      mentions: [{
        kind: MENTION_KIND_V1.session,
        ref: buildMentionRefForKindV1(MENTION_KIND_V1.session, 'source-session'),
        token: '@session:source',
        start: 0,
        end: 15,
      }],
    };

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'push', message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'isolate', message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ type: 'clear', message }),
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText,
        registerProviderAcceptedEffect: () => undefined,
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'compare with @session:source' },
      localId: 'local-mention-1',
      meta: {
        happierStructuredInputV1: structuredInput,
      },
    } as UserMessage);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(queueCalls).toEqual([]);
    expect(steerText.mock.calls[0]?.[0]).toContain('source-session');
    expect(steerText.mock.calls[0]?.[0]).toContain('compare with @session:source');
    expect(steerText.mock.calls[0]?.[1]).toMatchObject({ localId: 'local-mention-1', structuredInput: { v: 1 } });
  });

  it('carries only the exact admitted SessionMedia items alongside their Composer refs', () => {
    const harness = createHarness();
    const media = {
      id: 'media-review-1',
      role: 'input' as const,
      category: 'attachment' as const,
      mediaKind: 'image' as const,
      mimeType: 'image/png',
      name: 'review.png',
      path: '.happier/uploads/messages/session-1/local-review/review.png',
      sizeBytes: 67,
      sha256: 'a'.repeat(64),
      origin: { source: 'user-upload' as const },
    };

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this review image' },
      localId: 'local-review',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'review-media-1',
            attachment: { pluginId: 'acme.review', localId: 'review-media' },
            key: 'review-image',
            value: { reviewId: '42' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
            content: { kind: 'sessionMedia', mediaId: media.id },
          }],
        },
        happier: {
          kind: 'session_media.v1',
          payload: { media: [media] },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([{
      type: 'isolate',
      message: {
        localId: 'local-review',
        structuredInput: {
          composerAttachments: [{ content: { kind: 'sessionMedia', mediaId: media.id } }],
        },
        sessionMedia: [media],
      },
    }]);
  });

  it('rejects a malformed canonical envelope instead of falling back to a text-only prompt', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'do not dispatch forged attachment data' },
      localId: 'forged-canonical-input',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          resolvedComposerAttachments: [{ instanceId: 'forged' }],
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([]);
    expect(harness.rejectPromptBeforeProvider).toHaveBeenCalledWith({
      localIds: ['forged-canonical-input'],
      userMessageSeq: null,
    });
  });

  it('refuses only the composer attachment whose media is still an unfinalized staged claim', () => {
    // A queued Pending row stores raw Message *ingress*: only the target daemon's
    // `finalizeComposerStagedMediaToSession`, which runs inside canonical Message
    // admission, replaces this transfer-owned claim with the durable `sessionMedia`
    // reference. The queue binding consumes the admitted envelope only, so an envelope
    // that never reached that finalizer must fail closed rather than hand the provider a
    // stage id it cannot resolve — while the same attachment without a staged claim is
    // ordinary admitted input and still reaches the queue.
    const attachment = {
      v: 1,
      instanceId: 'review-media-1',
      attachment: { pluginId: 'acme.review', localId: 'review-media' },
      key: 'review-image',
      value: { reviewId: '42' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const stagedContent = {
      kind: 'stagedMedia',
      handle: {
        v: 1,
        id: 'stage-review-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        owner: { pluginId: 'acme.review', localId: 'review-media' },
        mediaKind: 'image',
        mimeType: 'image/png',
        name: 'review.png',
        sizeBytes: 67,
        sha256: 'a'.repeat(64),
      },
    };

    const staged = createHarness();
    staged.emit({
      role: 'user',
      content: { type: 'text', text: 'look at this screenshot' },
      localId: 'pending-staged-media',
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{ ...attachment, content: stagedContent }],
        },
      },
    } as UserMessage);

    expect(staged.queueCalls).toEqual([]);
    expect(staged.rejectPromptBeforeProvider).toHaveBeenCalledWith({
      localIds: ['pending-staged-media'],
      userMessageSeq: null,
    });

    const finalized = createHarness();
    finalized.emit({
      role: 'user',
      content: { type: 'text', text: 'look at this screenshot' },
      localId: 'pending-contentless-attachment',
      meta: {
        happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
      },
    } as UserMessage);

    expect(finalized.queueCalls).toMatchObject([{
      type: 'isolate',
      message: {
        localId: 'pending-contentless-attachment',
        structuredInput: { composerAttachments: [attachment] },
      },
    }]);
    expect(finalized.rejectPromptBeforeProvider).not.toHaveBeenCalled();
  });

  it('does not decode a raw attachment envelope as structured input', () => {
    const harness = createHarness();
    const attachment = {
      v: 1,
      instanceId: 'review-instance-1',
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment' },
    };

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'inspect this review' },
      localId: 'raw-attachment-without-admission',
      meta: {
        happier: {
          kind: 'attachments.v1',
          payload: { attachments: [attachment] },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([{
      type: 'push',
      message: {
        text: 'inspect this review',
        localId: 'raw-attachment-without-admission',
      },
    }]);
    expect(harness.queueCalls[0]?.message.structuredInput).toBeUndefined();
  });

  it('threads the committed user-message seq into the queued prompt for exact local-command replay suppression', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-seq-1' ? 42 : null),
        sessionId: 'receiver',
      },
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    userMessageHandler!({
      role: 'user',
      content: { type: 'text', text: 'confirm me later' },
      localId: 'local-seq-1',
      meta: {},
    } as UserMessage);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'confirm me later',
          localId: 'local-seq-1',
          localIds: ['local-seq-1'],
          userMessageSeq: 42,
          userMessageSeqs: [42],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it('does not queue the same committed user-message row twice', () => {
    const queueCalls: Array<{ message: PermissionModeQueuedPrompt }> = [];
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;

    registerPermissionModeMessageQueueBinding({
      session: {
        onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
          userMessageHandler = handler;
        },
        updateMetadata: () => void 0,
        getCommittedUserMessageSeq: (localId: string) => (localId === 'local-dup-1' ? 7 : null),
        sessionId: 'receiver',
      },
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push({ message }),
      },
      getCurrentPermissionMode: () => 'default' as PermissionMode,
      setCurrentPermissionMode: () => void 0,
    });

    const message = {
      role: 'user',
      content: { type: 'text', text: 'deliver exactly once' },
      localId: 'local-dup-1',
      meta: {},
    } as UserMessage;

    expect(userMessageHandler!(message)).toBe(true);
    expect(userMessageHandler!(message)).toBe(true);

    expect(queueCalls).toEqual([
      {
        message: {
          text: 'deliver exactly once',
          localId: 'local-dup-1',
          localIds: ['local-dup-1'],
          userMessageSeq: 7,
          userMessageSeqs: [7],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it('queues the message permission intent without changing the owner baseline', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-2',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(harness.getCurrentPermissionMode()).toBeUndefined();
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'approve this',
          localId: 'local-2',
          localIds: ['local-2'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'safe-yolo',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it('queues model overrides from user message metadata as a prompt mode dimension', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'use this model' },
      localId: 'local-model-1',
      meta: { model: ' opencode/big-pickle ' },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'use this model',
          localId: 'local-model-1',
          localIds: ['local-model-1'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'default',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
          modelSelection: {
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: null,
            modelId: 'opencode/big-pickle',
          },
        },
      },
    ]);
  });

  it('prefers a target-matched structured model selection over the legacy projection', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'use this provider model' },
      localId: 'local-structured-model-1',
      meta: {
        model: 'stale-native-model',
        modelSelectionV1: {
          v: 1,
          updatedAt: 42,
          ref: {
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: 'pc_openrouter',
            modelId: 'default',
          },
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'use this provider model',
          localId: 'local-structured-model-1',
          localIds: ['local-structured-model-1'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'default',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
          modelSelection: {
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
            providerConnectionId: 'pc_openrouter',
            modelId: 'default',
          },
        },
      },
    ]);
  });

  it('fails closed for a legacy model-only message when the active selection is Provider-bound', () => {
    const harness = createHarness({
      agentTargetKey: 'agent:happier.agent.opencode/opencode',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_openrouter'),
      modelId: 'provider-active',
    });

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'must not bypass the Provider owner' },
      localId: 'local-provider-legacy-model',
      meta: { model: 'legacy-bypass' },
    } as UserMessage);

    expect(harness.queueCalls).toEqual([]);
  });

  it('rejects before provider effect when structured model metadata is invalid or targets another agent', () => {
    const harness = createHarness();

    for (const [localId, modelSelectionV1] of [
      ['local-invalid-model', { v: 1, updatedAt: 42, ref: { agentTargetKey: 'agent:happier.agent.opencode/opencode', providerConnectionId: 'pc_1', modelId: 'invalid model' } }],
      ['local-wrong-target', { v: 1, updatedAt: 43, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_1', modelId: 'provider-model' } }],
    ] as const) {
      harness.emit({
        role: 'user',
        content: { type: 'text', text: localId },
        localId,
        meta: { model: 'must-not-apply', modelSelectionV1 },
      } as UserMessage);
    }

    expect(harness.queueCalls).toEqual([]);
    expect(harness.rejectPromptBeforeProvider.mock.calls).toEqual([
      [{
        localIds: ['local-invalid-model'],
        userMessageSeq: null,
      }],
      [{
        localIds: ['local-wrong-target'],
        userMessageSeq: null,
      }],
    ]);
  });

  it('keeps turn overrides local after bindSession swaps the client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    reboundSession.emit({
      role: 'user',
      content: { type: 'text', text: 'approve this' },
      localId: 'local-rebind-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(reboundSession.getMetadata().permissionMode).toBe('default');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'approve this',
          localId: 'local-rebind-1',
          localIds: ['local-rebind-1'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'safe-yolo',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it('ignores old-session user messages after bindSession swaps to a new client', () => {
    const harness = createHarness();
    const reboundSession = createSessionHarness();

    harness.bindSession(reboundSession.session);

    const accepted = harness.emit({
      role: 'user',
      content: { type: 'text', text: 'stale session message' },
      localId: 'local-stale-1',
      meta: { permissionMode: 'acceptEdits' },
      createdAt: 42,
    } as UserMessage);

    expect(accepted).toBe(false);
    expect(harness.getCurrentPermissionMode()).toBeUndefined();
    expect(harness.getMetadata().permissionMode).toBe('default');
    expect(harness.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(reboundSession.getMetadata().permissionMode).toBe('default');
    expect(reboundSession.getMetadata().permissionModeUpdatedAt).toBe(0);
    expect(harness.queueCalls).toEqual([]);
  });

  it('routes clear commands through isolate-and-clear queue path', () => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text: '/clear' },
      localId: 'local-3',
      meta: {},
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'clear',
        message: {
          text: '/clear',
          localId: 'local-3',
          localIds: ['local-3'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'default',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });

  it.each(['/clear', '/compact preserve the summary'])('isolates structured input even when %s is non-steerable', (text) => {
    const harness = createHarness();

    harness.emit({
      role: 'user',
      content: { type: 'text', text },
      localId: `local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          skillMentions: [{ name: 'review', path: '/skills/review/SKILL.md' }],
        },
      },
    } as UserMessage);

    expect(harness.queueCalls).toMatchObject([
      {
        type: 'isolate',
        message: {
          text,
          localId: `local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`,
          localIds: [`local-structured-${text.startsWith('/clear') ? 'clear' : 'compact'}`],
          structuredInput: {
            v: 1,
            skillMentions: [{ name: 'review', path: '/skills/review/SKILL.md' }],
          },
        },
        mode: { permissionMode: 'default' },
      },
    ]);
  });

  it('passes the user message local id when steering an in-flight turn', async () => {
    const sessionHarness = createSessionHarness();
    const queueCalls: PermissionModeQueuedPrompt[] = [];
    const steerCalls: Array<Readonly<{ text: string; localId: string | null | undefined }>> = [];

    registerPermissionModeMessageQueueBinding({
      session: sessionHarness.session,
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolate: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => {
          queueCalls.push(message);
        },
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        steerText: async (text, options) => {
          steerCalls.push({ text, localId: options?.localId });
        },
        registerProviderAcceptedEffect: () => undefined,
      },
    });

    sessionHarness.emit({
      role: 'user',
      content: { type: 'text', text: 'nudge active turn' },
      localId: 'local-steer-1',
      meta: {},
    } as UserMessage);

    await vi.waitFor(() => {
      expect(steerCalls).toHaveLength(1);
    });

    expect(queueCalls).toEqual([]);
    expect(steerCalls).toEqual([
      {
        text: `${LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK}\n\nnudge active turn`,
        localId: 'local-steer-1',
      },
    ]);
  });

  it('releases a replay-seed association when steerability is lost before provider dispatch', async () => {
    let metadata = {
      permissionMode: 'default',
      permissionModeUpdatedAt: 0,
      replaySeedV1: {
        v: 1,
        seedText: 'SEED',
        sourceSessionId: 'parent',
        sourceCutoffSeqInclusive: 3,
        createdAtMs: 123,
      },
    } as unknown as Metadata;
    let userMessageHandler: ((message: UserMessage) => boolean | void) | null = null;
    const session = {
      onUserMessage: (handler: (message: UserMessage) => boolean | void) => {
        userMessageHandler = handler;
      },
      getMetadataSnapshot: () => metadata,
      updateMetadata: (updater: (current: Metadata) => Metadata) => {
        metadata = updater(metadata);
      },
      readDurableProviderInputAcceptanceV1: async () => 'not_accepted' as const,
      sessionId: 'receiver',
    };
    const emitUserMessage = (message: UserMessage) => {
      if (!userMessageHandler) throw new Error('missing onUserMessage handler');
      return userMessageHandler(message);
    };
    const queueCalls: PermissionModeQueuedPrompt[] = [];
    const steerText = vi.fn(async () => undefined);
    let steerabilityReadCount = 0;

    registerPermissionModeMessageQueueBinding({
      session,
      queue: {
        getContextOnlyMessages: () => [],
        push: (message: PermissionModeQueuedPrompt) => queueCalls.push(message),
        pushIsolate: (message: PermissionModeQueuedPrompt) => queueCalls.push(message),
        pushIsolateAndClear: (message: PermissionModeQueuedPrompt) => queueCalls.push(message),
      },
      getCurrentPermissionMode: () => 'default',
      setCurrentPermissionMode: () => undefined,
      inFlightSteer: {
        supportsInFlightSteer: () => true,
        isTurnInFlight: () => true,
        canSteerPrompt: () => {
          steerabilityReadCount += 1;
          return steerabilityReadCount === 1;
        },
        steerText,
        registerProviderAcceptedEffect: () => undefined,
      },
    });

    emitUserMessage({
      role: 'user',
      content: { type: 'text', text: 'nudge active turn' },
      localId: 'local-steer-seed',
      meta: {},
    } as UserMessage);

    await vi.waitFor(() => expect(queueCalls).toHaveLength(1));
    expect(steerText).not.toHaveBeenCalled();
    expect((metadata as Metadata & { replaySeedV1?: { seedText?: string; dispatchedToLocalId?: string } }).replaySeedV1)
      .toMatchObject({ seedText: 'SEED' });
    expect((metadata as Metadata & { replaySeedV1?: { dispatchedToLocalId?: string } }).replaySeedV1?.dispatchedToLocalId)
      .toBeUndefined();
  });

  it('reads appendSystemPrompt from prototype-less metadata objects', () => {
    const harness = createHarness();
    const meta = Object.assign(Object.create(null) as Record<string, unknown>, {
      appendSystemPrompt: 'Use the latest project conventions.',
    });

    harness.emit({
      role: 'user',
      content: { type: 'text', text: 'hello world' },
      localId: 'local-4',
      meta,
    } as UserMessage);

    expect(harness.queueCalls).toEqual([
      {
        type: 'push',
        message: {
          text: 'hello world',
          localId: 'local-4',
          localIds: ['local-4'],
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
        mode: {
          permissionMode: 'default',
          appendSystemPrompt: 'Use the latest project conventions.',
          inputContextBlock: LEGACY_UNKNOWN_INPUT_CONTEXT_BLOCK,
        },
      },
    ]);
  });
});
