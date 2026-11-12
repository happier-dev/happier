import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createXaiVoiceRuntimeEnvironment, XaiVoiceWebSocket } from '@/dev/testkit/harness/xaiVoiceRuntime';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { storage } from '@/sync/domains/state/storage';
import { withGeneratedElevenLabsVoiceRuntime } from '@/dev/testkit/harness/elevenLabsVoiceRuntime';
import { readCanonicalVoiceTranscriptSnapshot, subscribeCanonicalVoiceTranscript } from '@/voice/transcript/voiceConversationTranscript';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { getVoiceSessionSpokenActionConfirmation, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';

type ElevenSdkOptions = Readonly<{
  onConnect?: () => void;
  onMessage?: (message: Readonly<{ source: 'user'; role: 'user'; message: string; event_id: number }>) => void;
  onIncomingEvent?: (event: unknown) => void;
  clientTools?: Readonly<Record<string, (parameters: Readonly<Record<string, unknown>>) => Promise<unknown>>>;
}>;
const eleven = vi.hoisted(() => ({
  options: null as ElevenSdkOptions | null,
  sendUserMessage: vi.fn(), sendContextualUpdate: vi.fn(), endSession: vi.fn(async () => {}),
  startSession: vi.fn(async (options: ElevenSdkOptions) => {
    eleven.options = options;
    options.onConnect?.();
    return { getId: () => 'origin-eleven', endSession: eleven.endSession,
      sendUserMessage: eleven.sendUserMessage, sendContextualUpdate: eleven.sendContextualUpdate,
      setMicMuted: () => {}, setVolume: () => {} };
  }),
}));
vi.mock('@elevenlabs/client', () => ({ Conversation: { startSession: eleven.startSession } }));
vi.mock('@elevenlabs/client/web', () => ({ Conversation: { startSession: eleven.startSession } }));

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-audio', async () =>
  (await import('@/dev/testkit/mocks/expoAudio')).expoAudioModuleMock());

type Opening = 'microphone' | 'after_initial_context' | 'late_microphone' | 'typed' | 'host_text' | 'context' | 'greeting' | 'overlapping_greeting_microphone' | 'missing' | 'older_response' | 'late_previous_microphone' | 'overlapping_host_microphone' | 'continuation' | 'readback' | 'readback_unavailable' | 'readback_overlapping_microphone';

const actionApprovalSettings = ActionsSettingsV1Schema.parse({ v: 1,
  actions: { 'settings.set': { approvalRequiredSurfaces: ['voice'] } } });

function settledToolOutcome(value: unknown) {
  let result = value;
  if (typeof value === 'string') {
    try { result = JSON.parse(value); } catch { result = null; }
  }
  return { toolResult: 'settled',
    ok: result && typeof result === 'object' ? Reflect.get(result, 'ok') : undefined,
    errorCode: result && typeof result === 'object' ? Reflect.get(result, 'errorCode') : undefined };
}

describe('realtime response origin and canonical approval', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each<Opening>([
    'microphone', 'after_initial_context', 'late_microphone', 'typed', 'host_text', 'context', 'greeting', 'overlapping_greeting_microphone', 'missing', 'older_response', 'late_previous_microphone', 'overlapping_host_microphone', 'continuation', 'readback', 'readback_unavailable', 'readback_overlapping_microphone',
  ])('keeps approval bound to the input opening the response (%s)', async opening => {
    const approvals = createArtifactStoreBoundary({ ownerAccountId: () => 'xai-composed-account', encryptionMode: 'plain' });
    const review = createDeferred<void>();
    const secondReview = createDeferred<void>();
    approvals.afterNextCreate(async () => {
      review.resolve();
      approvals.afterNextCreate(async () => { secondReview.resolve(); });
    });
    let writes = 0;
    const environment = await createXaiVoiceRuntimeEnvironment({
      canApproveRequests: true,
      actionsSettings: actionApprovalSettings,
      immediateWelcome: opening === 'greeting' || opening === 'overlapping_greeting_microphone',
      accountRequest: (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith('/v1/artifacts')) return approvals.handle(path, init);
        if (path === '/v2/account/settings' && init?.method === 'POST') {
          const update = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
          expect(update.content?.t).toBe('plain');
          writes += 1;
          // Observe the actual wire write; the fixture's canonical Settings CAS answers it.
          return null;
        }
        return null;
      },
    });
    await environment.installSettings(false);
    const composed = await environment.createRuntime();
    const previousLifecycle = getVoiceSessionLifecycleController();
    const lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId(composed.runtime.adapter.id);
    setVoiceSessionLifecycleController(lifecycle);
    // VoiceSessionRuntime publishes these exact lifecycle snapshots in the app.
    const unsubscribeLifecycle = lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    let eventSequence = 0;
    const emit = (event: Readonly<Record<string, unknown>>) => XaiVoiceWebSocket.instances[0]!.emit('message', {
      data: JSON.stringify({ event_id: `origin-event-${++eventSequence}`, ...event }),
    });
    const response = (id: string) => emit({ type: 'response.created', response: { id, status: 'in_progress' } });
    const finishMicrophone = (itemId: string) => emit({
      type: 'conversation.item.input_audio_transcription.completed', item_id: itemId, transcript: 'Change the minimum speech duration',
    });
    const commitMicrophone = (itemId: string) => emit({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: null });
    const call = (responseId: string, callId: string, name: string, args: unknown) => {
      emit({ type: 'response.function_call_arguments.done', response_id: responseId, call_id: callId,
        name, arguments: JSON.stringify({ arguments_json: JSON.stringify(args) }), output_index: 0 });
      emit({ type: 'response.done', response: { id: responseId } });
    };
    try {
      await composed.runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null,
        ...(opening === 'after_initial_context' ? { initialContext: 'Current UI context' } : {}) });
      expect(composed.runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected' });
      expect(getVoiceSessionSpokenActionConfirmation()).not.toBeNull();
      const socket = XaiVoiceWebSocket.instances[0]!;
      expect(socket).toBeDefined();
      const toolOutcome = (callId: string) => waitForTestEvent(XaiVoiceWebSocket.subscribe,
        () => socket.sent.map(value => JSON.parse(value)),
        sent => sent.some(value => value.item?.type === 'function_call_output' && value.item.call_id === callId))
        .then(sent => settledToolOutcome(sent.find(value => value.item?.type === 'function_call_output'
          && value.item.call_id === callId)?.item.output));
      const committed = toolOutcome('effect-call').then(result => result.ok === true ? 'committed' : result);
      if (opening === 'microphone' || opening === 'after_initial_context' || opening === 'late_microphone' || opening === 'continuation'
        || opening === 'readback' || opening === 'readback_unavailable' || opening === 'readback_overlapping_microphone') {
        commitMicrophone('person-audio');
        if (opening !== 'late_microphone') finishMicrophone('person-audio');
        response('person-response');
        if (opening === 'late_microphone') finishMicrophone('person-audio');
      } else if (opening === 'typed') {
        await composed.runtime.adapter.sendTextTurn!({ controlSessionId: composed.controlSessionId,
          conversationSessionId: environment.historySessionId, text: 'Change the minimum speech duration',
          localId: 'person-typed', deliveryCommand: 'interrupt_and_send', onAccepted: async () => {} });
        response('person-response');
      } else if (opening === 'host_text') {
        commitMicrophone('previous-person-audio');
        response('previous-person-response');
        finishMicrophone('previous-person-audio');
        await waitForTestEvent(listener => subscribeCanonicalVoiceTranscript(environment.historySessionId, listener),
          () => readCanonicalVoiceTranscriptSnapshot(environment.historySessionId), rows => rows.some(row => row.role === 'user'));
        composed.runtime.adapter.resolveContextChannel!(storage.getState().settings)!.sendTextMessage(
          'Session update: change the minimum speech duration');
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => value.includes('Session update:')));
        response('synthetic-response');
      } else if (opening === 'context') {
        commitMicrophone('previous-person-audio');
        response('previous-person-response');
        finishMicrophone('previous-person-audio');
        await waitForTestEvent(listener => subscribeCanonicalVoiceTranscript(environment.historySessionId, listener),
          () => readCanonicalVoiceTranscriptSnapshot(environment.historySessionId), rows => rows.some(row => row.role === 'user'));
        composed.runtime.adapter.sendContextUpdate({ sessionId: composed.controlSessionId, update: 'Change the minimum speech duration' });
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => value.includes('[Context update]')));
        response('synthetic-response');
      } else if (opening === 'older_response') {
        response('synthetic-response');
        commitMicrophone('later-person-audio');
        finishMicrophone('later-person-audio');
        response('later-person-response');
      } else if (opening === 'overlapping_host_microphone') {
        composed.runtime.adapter.resolveContextChannel!(storage.getState().settings)!.sendTextMessage(
          'Session update: change the minimum speech duration');
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => value.includes('Session update:')));
        commitMicrophone('overlapping-person-audio');
        finishMicrophone('overlapping-person-audio');
        response('synthetic-response');
      } else if (opening === 'late_previous_microphone') {
        commitMicrophone('previous-person-audio');
        response('previous-person-response');
        emit({ type: 'response.output_audio_transcript.delta', response_id: 'previous-person-response',
          item_id: 'previous-assistant', delta: 'Preparing' });
        await waitForTestEvent(listener => subscribeCanonicalVoiceTranscript(environment.historySessionId, listener),
          () => readCanonicalVoiceTranscriptSnapshot(environment.historySessionId), rows => rows.some(row => row.role === 'assistant'));
        composed.runtime.adapter.resolveContextChannel!(storage.getState().settings)!.sendTextMessage(
          'Session update: change the minimum speech duration');
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => value.includes('Session update:')));
        response('synthetic-response');
        finishMicrophone('previous-person-audio');
      } else if (opening === 'greeting' || opening === 'overlapping_greeting_microphone') {
        expect(socket.sent.some(value => JSON.parse(value).type === 'response.create')).toBe(true);
        if (opening === 'overlapping_greeting_microphone') {
          commitMicrophone('overlapping-greeting-person-audio');
          finishMicrophone('overlapping-greeting-person-audio');
        }
        response('synthetic-response');
      }
      if (opening === 'continuation') {
        call('person-response', 'lookup-call', 'action_spec_get', { actionId: 'settings.set' });
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => value.includes('function_call_output') && value.includes('lookup-call')));
        await waitForTestEvent(XaiVoiceWebSocket.subscribe, () => socket.sent,
          sent => sent.some(value => JSON.parse(value).type === 'response.create'));
        response('continued-person-response');
      }
      const readback = opening === 'readback' || opening === 'readback_unavailable' || opening === 'readback_overlapping_microphone';
      const person = ['microphone', 'after_initial_context', 'late_microphone', 'typed', 'continuation'].includes(opening) || readback;
      const actionInput = readback ? { anchor: 'voiceConversations.canApproveRequests', value: false }
        : { anchor: 'spaces.enabled', value: false };
      expect(getActionSpec('settings.set').safetyForInput?.(actionInput)).toBe(readback ? 'danger' : 'safe');
      expect(isApprovalRequiredByActionsSettings('settings.set', storage.getState().settings.actionsSettingsV1,
        { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' } }, undefined, undefined, actionInput)).toBe(true);
      call(opening === 'continuation' ? 'continued-person-response' : person ? 'person-response' : 'synthetic-response',
        'effect-call', 'action_execute', { actionId: 'settings.set', input: actionInput });
      if (readback) {
        let unsubscribe = () => {};
        try {
          const outcome = await Promise.race([
            waitForTestEvent(listener => { unsubscribe = XaiVoiceWebSocket.subscribe(listener); return unsubscribe; },
              () => socket.sent.map(value => JSON.parse(value)),
              sent => sent.some(value => value.item?.type === 'force_message')).then(() => 'host_summary'),
            review.promise.then(() => 'review'),
            toolOutcome('effect-call'),
          ]);
          expect(outcome).toBe('host_summary');
        } finally { unsubscribe(); }
        const forced = socket.sent.map(value => JSON.parse(value)).find(value => value.item?.type === 'force_message');
        expect(writes).toBe(0);
        expect(approvals.list()).toHaveLength(0);
        if (opening === 'readback_overlapping_microphone') {
          commitMicrophone('overlapping-readback-person-audio');
          finishMicrophone('overlapping-readback-person-audio');
          response('host-summary-response');
          call('host-summary-response', 'host-summary-effect', 'action_execute', { actionId: 'settings.set',
            input: { anchor: 'spaces.enabled', value: false } });
          const result = await Promise.race([secondReview.promise.then(() => 'review'), committed,
            toolOutcome('host-summary-effect')]);
          expect(result).toBe('review');
          expect(writes).toBe(0);
          expect(approvals.list()).toHaveLength(2);
          return;
        }
        response('host-summary-response');
        if (opening === 'readback') {
          emit({ type: 'response.output_audio.delta', response_id: 'host-summary-response', item_id: forced.item.id, delta: 'AQACAA==' });
          emit({ type: 'response.output_audio_transcript.done', response_id: 'host-summary-response', item_id: forced.item.id,
            transcript: forced.item.content[0].text });
        }
        emit({ type: 'response.done', response: { id: 'host-summary-response', status: 'completed' } });
        if (opening === 'readback') {
          const audio = environment.audioContexts.find(context => context.processor.onaudioprocess !== null);
          if (!audio) throw new Error('Expected real browser PCM output owner');
          const source = await audio.sourceCreated();
          await source.started;
          expect(writes).toBe(0);
          expect(approvals.list()).toHaveLength(0);
          source.onended?.();
        }
      }
      const confirmed = person && opening !== 'readback_unavailable';
      const result = await Promise.race([committed, review.promise.then(() => 'review')]);
      expect(result).toBe(confirmed ? 'committed' : 'review');
      expect(writes).toBe(confirmed ? 1 : 0);
      expect(approvals.list()).toHaveLength(confirmed ? 0 : 1);
    } finally {
      await composed.dispose();
      await lifecycle.dispose();
      unsubscribeLifecycle();
      setVoiceSessionLifecycleController(previousLifecycle);
      await environment.dispose();
    }
  });

  it.each(['person', 'host_after_person', 'context_after_person', 'first_message', 'missing'] as const)(
    'uses conservative ElevenLabs origin without a response identity (%s)', async opening => {
      eleven.options = null;
      eleven.sendUserMessage.mockClear();
      eleven.sendContextualUpdate.mockClear();
      const approvals = createArtifactStoreBoundary({ ownerAccountId: () => 'qa-account', encryptionMode: 'plain' });
      const review = createDeferred<void>();
      approvals.afterNextCreate(async () => { review.resolve(); });
      await withGeneratedElevenLabsVoiceRuntime(async ({ adapter, home }) => {
        await adapter.start({ sessionId: '', requestedTargetSessionAddress: null });
        expect(adapter.getSnapshot()).toMatchObject({ status: 'connected' });
        expect(getVoiceSessionSpokenActionConfirmation()).not.toBeNull();
        const options = eleven.options;
        if (!options) throw new Error('Expected the actual ElevenLabs SDK connection');
        if (opening !== 'missing' && opening !== 'first_message') {
          options.onMessage?.({ source: 'user', role: 'user', message: 'Change the minimum speech duration', event_id: 41 });
          await waitForTestEvent(listener => subscribeCanonicalVoiceTranscript('qa-history', listener),
            () => readCanonicalVoiceTranscriptSnapshot('qa-history'), rows => rows.some(row => row.role === 'user'));
        }
        if (opening === 'host_after_person') {
          const sent = createDeferred<void>();
          eleven.sendUserMessage.mockImplementation(() => { sent.resolve(); });
          adapter.resolveContextChannel!(storage.getState().settings)!.sendTextMessage(
            'Session update: change the minimum speech duration');
          await sent.promise;
        } else if (opening === 'context_after_person') {
          const sent = createDeferred<void>();
          eleven.sendContextualUpdate.mockImplementation(() => { sent.resolve(); });
          adapter.sendContextUpdate({ sessionId: '', update: 'Change the minimum speech duration' });
          await sent.promise;
        }
        const parameters = { arguments_json: JSON.stringify({ actionId: 'settings.set',
          input: { anchor: 'spaces.enabled', value: false } }) };
        expect(isApprovalRequiredByActionsSettings('settings.set', storage.getState().settings.actionsSettingsV1,
          { surface: 'voice', authority: 'present_user', actionCaller: { kind: 'host' } }, undefined, undefined,
          { anchor: 'spaces.enabled', value: false })).toBe(true);
        options.onIncomingEvent?.({ type: 'client_tool_call', client_tool_call: {
          tool_call_id: 'eleven-effect', tool_name: 'action_execute', parameters,
        } });
        const pending = options.clientTools?.action_execute?.(parameters);
        if (!pending) throw new Error('Expected the registered canonical Action tool');
        const result = await Promise.race([review.promise.then(() => 'review'),
          pending.then(value => {
            const outcome = settledToolOutcome(value);
            return outcome.ok === true ? 'committed' : outcome;
          }, () => ({ toolResult: 'rejected' }))]);
        expect(result).toBe(opening === 'person' ? 'committed' : 'review');
        const writes = home.httpRequests.filter(request => request.path === '/v2/account/settings' && request.method === 'POST').length;
        expect(writes).toBe(opening === 'person' ? 1 : 0);
        expect(approvals.list()).toHaveLength(opening === 'person' ? 0 : 1);
      }, {
        canApproveRequests: true,
        actionsSettings: actionApprovalSettings,
        route: request => {
          if (request.path.startsWith('/v1/artifacts')) return approvals.handle(request.path, {
            method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
          }) ?? undefined;
          return undefined;
        },
      });
    },
  );
});
