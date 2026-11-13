import { afterAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionPermissionRespondRpcParamsV1Schema } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';
import { NativePermissionChoiceAnswerV1Schema, type NativePermissionChoicesV1 } from '@happier-dev/protocol/sessions/permissions/nativeChoicesV1';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { buildCodexPermissionChoices } from '../../../../../packages/plugins/codex/src/agent/runtime/core/permissionChoices';
import {
  getStorage, localVoiceHomeId, localVoiceSpeechTranscription, expoSpeechSpeak,
  setRecorderUri,
  registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope,
  waitForLocalVoiceBoundaryEvent, warmLocalVoiceEngineHarnessGraph,
  applyLocalVoiceSessionAgentState,
  readLocalVoiceHttpRequests,
} from './localVoiceEngine.testHarness';

const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreLoader());
const quotaRetryAtMs = Date.UTC(2026, 10, 14, 15);
const codexChoices = {
  requirementId: 'codex-exec-requirement', source: 'codex', choices: [
    { id: 'execpolicy', label: 'Allow this command rule', decision: 'approved_execpolicy_amendment', scope: 'localPersistent',
      response: { approved: true, decision: 'approved_execpolicy_amendment', execPolicyAmendment: { command: ['touch', '/tmp/native-voice-test'] } } },
    { id: 'acceptForSession', label: 'Allow for this session', decision: 'approved_for_session', scope: 'session',
      response: { approved: true, decision: 'approved_for_session' } },
    { id: 'cancel', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
    { id: 'accept', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } },
    { id: 'decline', label: 'Deny', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
  ],
} satisfies NativePermissionChoicesV1;
// RUN107 denial-after-next-turn.json: Codex offered no decline decision.
const run107Choices = buildCodexPermissionChoices('c713bac3-5b99-43b0-92f2-501fd696ff77', [
  'accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [
    '/bin/bash', '-lc', "printf %s 'denied' > /tmp/voice-run107-native-no.txt",
  ] } }, 'cancel',
]);
// RUN111 native-before-no.private.json: the exact offered command and choices.
const run111Choices = buildCodexPermissionChoices('03e65b05-e102-4526-83a8-3c9601d01431', [
  'accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [
    '/bin/bash', '-lc', "printf 'hollo.' > cold_hollo.txt",
  ] } }, 'cancel',
]);
const run120Choices = buildCodexPermissionChoices('16367ecb-d8ca-463b-8155-cf0fd0994e6e', [
  'accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: [
    '/bin/bash', '-lc', "printf 'orange' > orange",
  ] } }, 'cancel',
]);

describe('native Voice permission input', () => {
  registerLocalVoiceEngineHarnessHooks();

  it.each(["No, don't run it", 'NO DO NOT RUN IT I'])(
    'settles the read-out native request from the R143 speech entry: %s', async answer => {
      const storage = await getStorage();
      const state = storage.getState();
      const config = readLocalConversationVoiceSettings(state.settings.voice);
      storage.__setState({ settings: { ...state.settings, voice: { ...state.settings.voice,
        providerId: 'local_conversation', canApproveRequests: true,
        providers: { ...state.settings.voice.providers, local_conversation: { schemaVersion: 1,
          config: { ...config, conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: false } } } },
      } } });
      const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
      const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
      const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
      const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
      const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
      registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
      const lifecycle = createVoiceSessionLifecycleController();
      setVoiceSessionLifecycleController(lifecycle);
      lifecycle.setConfiguredProviderId('local_conversation');
      await lifecycle.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
      const controlSessionId = lifecycle.getSnapshot().sessionId!;
      const binding = voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId });
      expect(binding?.transcriptMode).toBe('native_session');
      const requestSessionId = binding!.conversationSessionId;
      const session = storage.getState().sessions[requestSessionId]!;
      await applyLocalVoiceSessionAgentState({ ...session, active: true,
        agentStateVersion: (session.agentStateVersion ?? 0) + 1,
        updatedAt: Math.max(Date.now(), session.updatedAt + 1),
        agentState: { requests: { 'native-write': { kind: 'permission', tool: 'Write',
          arguments: { file_path: '/tmp/native-voice-test' }, createdAt: Date.now(), nativeChoices: codexChoices } } },
      });
      const incumbent = sessionRpcWithServerScope.getMockImplementation()!;
      sessionRpcWithServerScope.mockImplementation(async request => {
        if (request.method !== RPC_METHODS.SESSION_PERMISSION_RESPOND) return incumbent(request);
        const payload = SessionPermissionRespondRpcParamsV1Schema.parse(request.payload);
        expect(payload).toMatchObject({ id: 'native-write', nativeChoice: {
          requirementId: codexChoices.requirementId, choiceId: 'decline',
        } });
        const pending = storage.getState().sessions[requestSessionId]!;
        await applyLocalVoiceSessionAgentState({ ...pending,
          agentStateVersion: (pending.agentStateVersion ?? 0) + 1,
          updatedAt: Math.max(Date.now(), pending.updatedAt + 1),
          agentState: { requests: {}, completedRequests: { 'native-write': {
            tool: 'Write', status: 'denied', completedAt: Date.now(), nativeChoice: 'nativeChoice' in payload ? payload.nativeChoice : undefined,
          } } },
        });
        return { ok: true };
      });
      const { createNativeVoicePermissionInput } = await import('./nativeVoicePermissionInput');
      const settled = vi.fn<Parameters<typeof createNativeVoicePermissionInput>[0]['onResponseSettled']>(async () => {});
      const readOut = vi.fn<Parameters<typeof createNativeVoicePermissionInput>[0]['readOut']>(async (_text, _listen, isCurrent, onReady) => { if (isCurrent()) onReady(); });
      const input = createNativeVoicePermissionInput({ controlSessionId,
        signal: new AbortController().signal, isConversationTurnPending: () => false,
        readOut, commitTranscript: async () => {}, onResponding() {}, onResponseSettled: settled,
      });
      try {
        await input.waitForPendingReadout();
        expect(input.canAccept()).toBe(true);
        const respond = input.captureResponse();
        expect(respond).not.toBeNull();
        await respond!(answer);
        expect(settled).toHaveBeenCalledWith({ ok: true, decision: 'denied' });
        expect(storage.getState().sessions[requestSessionId]?.agentState?.requests?.['native-write']).toBeUndefined();
        expect(storage.getState().sessions[requestSessionId]?.agentState?.completedRequests?.['native-write'])
          .toMatchObject({ status: 'denied' });
      } finally { input.dispose(); await lifecycle.stop(); }
    },
  );

  it.each([
    { label: 'RUN120 command preview with argument sharing off', enabled: true, answer: 'YES ALLOW THE COMMAND', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, run120: true },
    { label: 'Yes', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false },
    { label: 'Codex offered Yes after carrier settlement', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true },
    { label: 'Codex offered No', enabled: true, answer: "NO DON'T", approved: false, end: false, replaceRequest: false, delegated: true, nativeOffer: true },
    { label: 'RUN107 No with Stop as the only negative option', enabled: true, answer: "NO DON'T", approved: false, end: false, replaceRequest: false, delegated: true, nativeOffer: true, nativeStop: true },
    { label: 'RUN107 No after carrier settlement', enabled: true, answer: "NO DON'T", approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true },
    { label: 'RUN111 command refusal', enabled: true, answer: 'NO DO NOT ALLOW THE COMMAND', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true, run111: true },
    { label: 'RUN111 short refusal transcript', enabled: true, answer: 'NO BUT', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true, run111: true },
    { label: 'RUN114 ordinary question while a request remains pending', enabled: true, answer: 'WHAT IS THE CAPITAL OF FRANCE', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, run111: true, ordinaryQuestion: true },
    { label: 'RUN114 typed question retires the spoken permission prompt', enabled: true, answer: 'WHAT IS THE CAPITAL OF FRANCE', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, run111: true, ordinaryQuestion: true, typedQuestion: true },
    { label: 'RUN114 End Continue question while a request remains pending', enabled: true, answer: 'WHAT IS THE CAPITAL OF FRANCE', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, run111: true, ordinaryQuestion: true, continuedQuestion: true },
    { label: 'RUN113 Yes naming the command', enabled: true, answer: 'YES ALLOW THE COMMAND', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, run111: true },
    { label: 'RUN113 No naming the command', enabled: true, answer: "NO, DON'T ALLOW THE COMMAND", approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true, run111: true },
    { label: 'RUN111 Stop Ready excludes earlier progress', enabled: true, answer: 'NO DO NOT ALLOW THE COMMAND', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true, run111: true, stoppedReady: true },
    { label: 'a conflicting permission instruction', enabled: true, answer: 'NO BUT ALLOW IT', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, nativeStop: true, run111: true },
    { label: 'RUN111 ready-only delegated completion after Yes', enabled: true, answer: 'YES', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, syncedResult: true, readyOnly: true },
    { label: 'RUN111 completion with transcript privacy off', enabled: true, answer: 'YES', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, nativeOffer: true, syncedResult: true, readyOnly: true, resultPrivacyOff: true },
    { label: 'natural Yes go ahead', enabled: true, answer: 'YES, GO AHEAD.', approved: true, end: false, replaceRequest: false },
    { label: 'natural Okay do it after carrier settlement', enabled: true, answer: 'Okay, do it.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'natural No dont after carrier settlement', enabled: true, answer: 'No, don’t.', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'permission synthesis failure', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, readoutFailure: true },
    { label: 'permission synthesis failure followed by native denial', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, readoutFailure: true, turnError: 'claude_error_during_execution', continues: true },
    { label: 'permission playback failure after the carrier settles', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, readoutFailure: true, startedReadout: true, carrierSettled: true },
    { label: 'Yes, allow it', enabled: true, answer: 'Yes, allow it.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'No, deny it', enabled: true, answer: 'No, deny it.', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'No', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false },
    { label: 'delegated Yes', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true },
    { label: 'delegated Yes with a final acknowledgement during queued readout', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, replacedReadout: true },
    { label: 'delegated Yes with a final acknowledgement during playback', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, replacedReadout: true, startedReadout: true },
    { label: 'delegated Yes with an unstreamed acknowledgement', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, replacedReadout: true, nonStreaming: true },
    { label: 'delegated Yes with acknowledgement after readout', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, replacedReadout: true, readoutCompleteBeforeFinal: true },
    { label: 'delegated No', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, delegated: true },
    { label: 'delegated Yes after the carrier turn settles', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'a synced delegated result after the carrier turn settles', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, syncedResult: true },
    { label: 'retargeted delegated Yes', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true, retarget: true },
    { label: 'delegated No after the carrier turn settles', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'a failed delegated response', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, responseFailure: true },
    { label: 'UI-answered delegated permission', enabled: true, answer: '', approved: true, end: false, replaceRequest: false, delegated: true, uiAnswer: 'permission' },
    { label: 'UI-answered delegated question', enabled: true, answer: '', approved: true, end: false, replaceRequest: false, delegated: true, uiAnswer: 'question' },
    { label: 'No followed by native execution rejection', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', continues: true },
    { label: 'End after No before native execution rejection', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', endAfterResponse: true },
    { label: 'Yes followed by native execution rejection', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', continues: false },
    { label: 'No followed by lost transport', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'target_unavailable', continues: false },
    { label: 'an ordinary turn', enabled: true, answer: '', approved: null, end: false, replaceRequest: false },
    { label: 'an empty native follow-up', enabled: true, answer: '', approved: null, end: false, replaceRequest: false, emptyFollowUp: true },
    { label: 'provider quota before tools', enabled: true, answer: '', approved: null, end: false, replaceRequest: false, turnError: 'usage_limit', providerFailure: true },
    { label: 'End before provider quota settles', enabled: true, answer: '', approved: null, end: true, replaceRequest: false, turnError: 'usage_limit', providerFailure: true },
    { label: 'approval opt-out', enabled: false, answer: 'Yes, allow it.', approved: null, end: false, replaceRequest: false },
    { label: 'delegated approval opt-out after carrier settlement', enabled: false, answer: 'Yes, allow it.', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'an unclear answer', enabled: true, answer: 'Yes, but no.', approved: null, end: false, replaceRequest: false },
    { label: 'an empty transcript', enabled: true, answer: '', approved: null, end: false, replaceRequest: false },
    { label: 'an empty decision after the carrier settles', enabled: true, answer: '', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'an unclear decision after the carrier settles', enabled: true, answer: 'Maybe.', approved: null, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'End', enabled: true, answer: '', approved: null, end: true, replaceRequest: false },
    { label: 'a replacement request while ASR is pending', enabled: true, answer: 'Yes.', approved: null, end: false, replaceRequest: true },
  ])('reads a native permission aloud and respects $label', async ({ label, enabled, answer, approved, end, replaceRequest, turnError, continues, endAfterResponse, providerFailure, delegated, carrierSettled, responseFailure, uiAnswer, retarget, replacedReadout, emptyFollowUp, startedReadout, nonStreaming, readoutCompleteBeforeFinal, readoutFailure, syncedResult, nativeOffer, nativeStop, run111, run120, readyOnly, resultPrivacyOff, stoppedReady, ordinaryQuestion, continuedQuestion, typedQuestion }) => {
    const offeredChoices = run120 ? run120Choices : run111 ? run111Choices : nativeStop ? run107Choices : codexChoices;
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    storage.__setState({ settings: { ...state.settings, voice: {
      ...state.settings.voice, providerId: 'local_conversation', canApproveRequests: enabled,
      ...(run120 ? { privacy: { ...state.settings.voice.privacy, shareToolNames: true, shareToolArgs: false, shareFilePaths: false } } : {}),
      welcome: { ...state.settings.voice.welcome, enabled: false },
      providers: { ...state.settings.voice.providers, local_conversation: { schemaVersion: 1,
        config: { ...config, conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: false },
          streaming: { ...config.streaming, enabled: !nonStreaming },
          tts: { ...config.tts, provider: 'device', autoSpeakReplies: true } },
      } },
    } } });
    const asrStarted = createDeferred<void>();
    const asrHeld = createDeferred<string>();
    localVoiceSpeechTranscription.mockResolvedValueOnce(label === 'RUN111 short refusal transcript'
      ? 'WRITE THE REQUESTED FILE.' : 'Write the requested file.');
    if (label !== 'an ordinary turn' && !emptyFollowUp && !providerFailure && !uiAnswer && !typedQuestion) {
      localVoiceSpeechTranscription.mockImplementationOnce(async () => {
        asrStarted.resolve();
        return replaceRequest ? asrHeld.promise : answer;
      });
    }
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
    const { getVoiceSessionPresentedAttemptId, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
    const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
    const { executeVoiceConversationAction } = await import('@/sync/ops/actions/voiceConversationAction');
    const waiting = createDeferred<void>();
    let streamError = turnError;
    const original = sessionRpcWithServerScope.getMockImplementation()!;
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        await waiting.promise;
        if (streamError) {
          const errorCode = streamError;
          streamError = undefined;
          // Native denial terminates this model turn with an error stream event.
          return { streamId: 'stream-1', events: [{ t: 'error', errorCode,
            error: 'Native Agent session turn failed', ...(providerFailure ? { usageLimitRecovery: {
              v: 1, status: 'waiting', issueFingerprint: 'temporary-throttle:quota',
              armedAtMs: quotaRetryAtMs - 60_000, resetAtMs: null, nextCheckAtMs: quotaRetryAtMs,
              attemptCount: 0, maxAttempts: 0, lastProbeError: null, authSelectionKind: 'profile',
            } } : {}) }], nextCursor: 1, done: true };
        }
      }
      if (request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND || request.method === RPC_METHODS.SESSION_USER_ACTION_ANSWER) {
        if (responseFailure) throw Object.assign(new Error('Permission transport unavailable'), { rpcErrorCode: 'target_unavailable' });
        // Publish the daemon's answered-request update as well as its RPC result.
        const carrier = storage.getState().sessions[request.sessionId]!;
        const pending = carrier.agentState?.requests?.['native-write'];
        if (!pending) throw new Error(`The daemon permission fixture lost native-write before acknowledgement: ${JSON.stringify({
          sessionId: request.sessionId, agentState: carrier.agentState, agentStateVersion: carrier.agentStateVersion,
        })}`);
        if (nativeOffer) {
          // Genuine daemon RPC boundary: current native requests reject bare
          // booleans/decisions and require one of their offered selections.
          const selection = NativePermissionChoiceAnswerV1Schema.safeParse(request.payload.nativeChoice);
          if (!selection.success || selection.data.requirementId !== offeredChoices.requirementId
            || !offeredChoices.choices.some(choice => choice.id === selection.data.choiceId)) {
            throw Object.assign(new Error('permission_response_invalid'), { rpcErrorCode: 'permission_response_invalid' });
          }
        }
        await applyLocalVoiceSessionAgentState({
          ...carrier, agentStateVersion: (carrier.agentStateVersion ?? 0) + 1,
          updatedAt: Math.max(Date.now(), carrier.updatedAt + 1),
          agentState: { ...carrier.agentState, requests: {}, completedRequests: {
            ...carrier.agentState?.completedRequests,
            'native-write': { ...pending, status: approved ? 'approved' : 'denied',
              ...(nativeStop ? { decision: 'abort', nativeChoice: request.payload.nativeChoice } : {}), completedAt: Date.now() },
          } },
        });
        if (!endAfterResponse) waiting.resolve();
        return { ok: true };
      }
      return original(request);
    });
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    const unsubscribe = lifecycle.subscribe(() => {
      setVoiceSessionSnapshot(lifecycle.getSnapshot());
    });
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    let submitted: Promise<{ result: unknown } | { error: unknown }> | undefined;
    let finishReadout: (() => void) | undefined;
    try {
      await lifecycle.toggle(target);
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
      let expectedAttempt = getVoiceSessionPresentedAttemptId();
      const expectNextCommitAccepted = async () => {
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
          snapshot => snapshot.status === 'connected' && snapshot.mode === 'listening' && snapshot.canCommitInput === true);
        expect(lifecycle.getSnapshot(), JSON.stringify(lifecycle.getSnapshot())).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
        // Native recorders produce a fresh file; the preceding turn deleted its artifact.
        const { File } = await import('expo-file-system');
        const nextRecordingUri = 'file:///tmp/native-voice-followup.m4a';
        new File(nextRecordingUri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(nextRecordingUri);
        const nextQuestion = nativeStop ? 'What is two plus two?' : 'Continue the conversation.';
        const speechBeforeNextQuestion = expoSpeechSpeak.mock.calls.length;
        localVoiceSpeechTranscription.mockResolvedValueOnce(nextQuestion);
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        await expect(localVoiceSpeechTranscription.mock.results.at(-1)?.value).resolves.toBe(nextQuestion);
        if (nativeStop) {
          expect(expoSpeechSpeak.mock.calls.slice(speechBeforeNextQuestion).map(([text]) => text))
            .toContain('Daemon reply');
          expect(storage.getState().sessions[requestSessionId]?.agentState?.requests?.['native-write']).toBeUndefined();
        }
        await vi.waitFor(() => expect(lifecycle.getSnapshot(), JSON.stringify(lifecycle.getSnapshot()))
          .toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true }));
      };
      submitted = executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} })
        .then(result => ({ result }), error => ({ error }));
      await Promise.race([waitForLocalVoiceBoundaryEvent('stream-start'), submitted.then(result => {
        throw new Error(`Expected waiting native turn, received ${JSON.stringify(result)}`);
      })]);
      const binding = voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: lifecycle.getSnapshot().sessionId! });
      if (!binding) throw new Error('Expected native Voice conversation');
      expect(binding.transcriptMode).toBe('native_session');
      expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'thinking' });
      if (label === 'RUN111 short refusal transcript') {
        const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
        const { getSessionName } = await import('@/utils/sessions/sessionUtils');
        await vi.waitFor(() => expect(readSessionOwnerMetadataView(storage.getState().sessions[binding.conversationSessionId]!))
          .toMatchObject({ summary: { text: 'Write the requested file.' } }));
        expect(getSessionName(storage.getState().sessions[binding.conversationSessionId]!, localVoiceHomeId)).toBe('Write the requested file.');
        const { publishVoiceConversationFirstHumanTitle } = await import('@/voice/persistence/voiceConversationTitle');
        const titleWrites = () => readLocalVoiceHttpRequests().filter(request => request.method === 'PATCH'
          && request.path === `/v2/sessions/${binding.conversationSessionId}`).length;
        const writesBeforeNextTurn = titleWrites();
        await publishVoiceConversationFirstHumanTitle(binding.conversationSessionId, 'A DIFFERENT FOLLOW-UP.');
        expect(titleWrites()).toBe(writesBeforeNextTurn);
        const { sync } = await import('@/sync/sync');
        const { publishDisplayTitleMetadataMutation } = await import('@/sync/state/displayTitlePublish');
        await publishDisplayTitleMetadataMutation({ sessionId: binding.conversationSessionId, title: 'My chosen call name',
          updateSessionMetadataWithRetry: (id, updater) => sync.patchSessionMetadataWithRetry(id, updater, { serverId: localVoiceHomeId }) });
        await publishVoiceConversationFirstHumanTitle(binding.conversationSessionId, 'DO NOT REPLACE MY NAME.');
        expect(getSessionName(storage.getState().sessions[binding.conversationSessionId]!, localVoiceHomeId)).toBe('My chosen call name');
      }
      expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
        .toMatchObject({ status: 'unavailable', code: 'voice_commit_unavailable' });
      if (label === 'an ordinary turn' || emptyFollowUp) {
        waiting.resolve();
        await submitted;
        if (emptyFollowUp) {
          const { File } = await import('expo-file-system');
          const emptyUri = 'file:///tmp/native-voice-empty.m4a';
          new File(emptyUri).write(new Uint8Array([1, 2, 3]));
          setRecorderUri(emptyUri);
          localVoiceSpeechTranscription.mockResolvedValueOnce('');
          expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
            .toMatchObject({ status: 'completed' });
        }
        await expectNextCommitAccepted();
        return;
      }
      if (providerFailure) {
        if (end) await lifecycle.stop(target.sessionId);
        waiting.resolve();
        await submitted;
        if (end) {
          expect(lifecycle.getSnapshot().status).toBe('disconnected');
          expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
          expect(expoSpeechSpeak).not.toHaveBeenCalled();
        } else {
          const { t } = await import('@/text');
          const time = new Date(quotaRetryAtMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
          expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual([
            `${t('session.usageLimitRecovery.banner.title')} ${t('session.usageLimitRecovery.banner.retryAt', { time })}`,
          ]);
          expect(lifecycle.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'provider_error',
            errorMessage: 'usage_limit', errorRecoveryAction: 'none' });
          expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        }
        return;
      }
      const carrierId = binding.conversationSessionAddress.sessionId;
      const requestSessionId = delegated ? target.sessionId : carrierId;
      if (carrierSettled) {
        waiting.resolve();
        await submitted;
      }
      if (retarget) {
        const { createSessionFixture } = await import('@/dev/testkit');
        storage.getState().applySessions([createSessionFixture({ id: 'delegated-next', serverId: target.serverId,
          active: true, metadataLayoutVersion: 1,
          ownerMetadataView: { flavor: 'claude', machineId: 'machine-1', path: '/project' } })]);
        // Reach the same target-selection entry as session.open, retaining the
        // conversation admitted by the real lifecycle above.
        const { setPrimaryActionSessionId } = await import('@/voice/tools/actionImpl/sessionTargets');
        expect(await setPrimaryActionSessionId({ serverId: target.serverId, sessionId: 'delegated-next', updateLastFocused: true }))
          .toMatchObject({ ok: true });
        expect(voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: binding.controlSessionId })?.targetSessionAddress)
          .toEqual({ serverId: target.serverId, sessionId: 'delegated-next' });
      }
      const precedingSpeechCount = expoSpeechSpeak.mock.calls.length;
      const actualRequestSessionId = retarget ? 'delegated-next' : requestSessionId;
      if (readoutFailure) expoSpeechSpeak.mockImplementationOnce((_text, options) => {
        if (startedReadout) options.onStart?.();
        options.onError?.(new Error('native_permission_playback_failed'));
      });
      // The OS has accepted synthesis, but no playback buffer has started yet.
      if (replacedReadout) expoSpeechSpeak.mockImplementationOnce((_text, options) => {
        if (startedReadout) options.onStart?.();
        finishReadout = () => {
          finishReadout = undefined;
          if (!startedReadout) options.onStart?.();
          options.onDone?.();
        };
      });
      if (retarget) expoSpeechSpeak.mockImplementationOnce((_text, options) => {
        finishReadout = options.onDone;
        options.onStart?.();
      });
      const carrier = storage.getState().sessions[actualRequestSessionId]!;
      await applyLocalVoiceSessionAgentState({
        ...carrier, active: true, agentStateVersion: (carrier.agentStateVersion ?? 0) + 1,
        updatedAt: Math.max(Date.now(), carrier.updatedAt + 1),
        agentState: { requests: { 'native-write': uiAnswer === 'question'
          ? { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Which revision?', options: [{ label: 'Blue' }, { label: 'Red' }] }] }, createdAt: Date.now() }
          : { ...(run120 ? { kind: 'permission' as const, tool: 'Bash', arguments: null } : run111 ? { kind: 'permission' as const, tool: 'Bash', arguments: {
            command: '/bin/bash -lc "printf \'hollo.\' > cold_hollo.txt"', cwd: '/tmp/run111-codex',
          } } : { tool: 'Write', arguments: { file_path: '/tmp/native-voice-test' } }), createdAt: Date.now(),
            ...(nativeOffer ? { nativeChoices: offeredChoices } : {}) } } },
      });
      if (retarget) {
        const { voiceConversationBindingResolver } = await import('@/voice/binding/VoiceConversationBindingResolver');
        const { resolveVoiceContextSessionFromState } = await import('@/voice/context/resolveVoiceContextSession');
        const { listPendingSessionRequests } = await import('@/sync/domains/session/pending/listPendingSessionRequests');
        const address = { serverId: target.serverId, sessionId: actualRequestSessionId };
        expect(voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: binding.controlSessionId })?.targetSessionAddress)
          .toEqual(address);
        const resolved = resolveVoiceContextSessionFromState(address, storage.getState())!;
        expect(resolved.agentState?.requests).toHaveProperty('native-write');
        expect(listPendingSessionRequests(resolved, []))
          .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-write' })]));
      }
      if (uiAnswer) {
        const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
        const actions = createAppSessionTranscriptActions(requestSessionId, target.serverId);
        if (uiAnswer === 'question') await actions.answerUserAction({ id: 'native-write', answers: { 'Which revision?': ['Blue'] } });
        else await actions.respondToPermission({ id: 'native-write', approved: true });
        expect(await submitted).toHaveProperty('result');
        expect(storage.getState().sessions[requestSessionId]?.agentState?.completedRequests?.['native-write']).toMatchObject({ status: 'approved' });
        const callsBeforeFollowUp = sessionRpcWithServerScope.mock.calls.length;
        await expectNextCommitAccepted();
        expect(sessionRpcWithServerScope.mock.calls.slice(callsBeforeFollowUp).map(([request]) => request)).toContainEqual(expect.objectContaining({
          method: SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
          payload: expect.objectContaining({ message: expect.stringContaining('Continue the conversation.') }),
        }));
        return;
      }
      // A tap-only projection leaves the original turn Thinking and never speaks.
      if (retarget) await vi.waitFor(() => expect(expoSpeechSpeak.mock.calls[precedingSpeechCount]?.[0],
        'A permission in the live target must be read aloud').toContain('permission'));
      await waitForLocalVoiceBoundaryEvent('speech', precedingSpeechCount + 1);
      expect(expoSpeechSpeak.mock.calls[precedingSpeechCount]?.[0]).toContain('permission');
      if (run120) {
        const spoken = expoSpeechSpeak.mock.calls[precedingSpeechCount]?.[0];
        expect(spoken).toContain("printf 'orange' > orange");
        expect(spoken).not.toContain('/bin/bash');
      }
      if (label === 'RUN111 command refusal') {
        const { readStoredSessionMessages } = await import('@happier-dev/session-core/messages');
        const spoken = expoSpeechSpeak.mock.calls[precedingSpeechCount]?.[0];
        const transcript = readStoredSessionMessages(storage.getState(), binding.conversationSessionId);
        expect(transcript.find(message => message.kind === 'agent-text' && message.text === spoken),
          'A spoken permission question must be an acknowledged saved conversation row')
          .toMatchObject({ seq: expect.any(Number) });
      }
      if (readoutFailure) {
        await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'disconnected', errorCode: 'tts_failed', errorRecoveryAction: 'retry',
        }));
        expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        expect(storage.getState().sessions[actualRequestSessionId]?.agentState?.requests?.['native-write']).toBeDefined();
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        const whileNativeTurnWaits = async (operation: Promise<unknown>, stage: string) => {
          if (carrierSettled || !submitted) return await operation;
          await Promise.race([operation, submitted.then(result => {
            throw new Error(`The native turn settled before ${stage}: ${JSON.stringify(result)}`);
          })]);
        };
        await whileNativeTurnWaits(lifecycle.retry(binding.controlSessionId), 'capture recovery');
        expect(storage.getState().sessions[actualRequestSessionId]?.agentState?.requests,
          'Retry must retain the native permission before admitting its response').toHaveProperty('native-write');
        expectedAttempt = getVoiceSessionPresentedAttemptId();
        await whileNativeTurnWaits(waitForLocalVoiceBoundaryEvent('speech', precedingSpeechCount + 2), 'permission re-read');
        await whileNativeTurnWaits(waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
          snapshot => snapshot.canCommitInput === true), 'permission response readiness');
        expect(expoSpeechSpeak.mock.calls.slice(precedingSpeechCount).filter(([text]) => text.includes('permission'))).toHaveLength(2);
      }
      if (replacedReadout) {
        if (readoutCompleteBeforeFinal) {
          finishReadout?.();
          await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.canCommitInput === true);
        }
        waiting.resolve();
        // Drain the native stream's promise continuations while OS playback is
        // held. Its final acknowledgement must not cancel the pending readout.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(expoSpeechSpeak.mock.calls.slice(precedingSpeechCount),
          'The permission must play first without acknowledgement replacement or replay').toHaveLength(1);
        finishReadout?.();
        await submitted;
        expect(expoSpeechSpeak.mock.calls.slice(precedingSpeechCount)).toHaveLength(1);
      }
      if (retarget) {
        expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'speaking' });
        expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: target.serverId, sessionId: actualRequestSessionId });
        expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        finishReadout?.();
      }
      if (!enabled) {
        await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({
          status: 'connected', mode: 'listening', canCommitInput: true,
        }));
        const { File } = await import('expo-file-system');
        const uri = 'file:///tmp/tap-only-permission-answer.m4a';
        new File(uri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(uri);
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        await expect(localVoiceSpeechTranscription.mock.results.at(-1)?.value).resolves.toBe(answer);
        const { t } = await import('@/text');
        expect(expoSpeechSpeak.mock.calls.at(-1)?.[0]).toBe(t('voice.readiness.permissionTapRequired'));
        expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'listening', canCommitInput: true });
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        expect(storage.getState().sessions[actualRequestSessionId]?.agentState?.requests?.['native-write']).toBeDefined();
        const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
        await createAppSessionTranscriptActions(actualRequestSessionId, target.serverId).respondToPermission({ id: 'native-write', approved: true });
        await submitted;
        await expectNextCommitAccepted();
        return;
      }
      await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.canCommitInput === true);
      if (end) {
        expect(await executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        expect(lifecycle.getSnapshot().status).toBe('disconnected');
        waiting.resolve();
        await submitted;
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'unavailable' });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected' });
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        return;
      }
      if (continuedQuestion) {
        expect(await executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        const speechBeforeContinue = expoSpeechSpeak.mock.calls.length;
        // The mounted Action adopts this lifecycle through AppShell's runtime
        // request. This bare engine harness already owns the real lifecycle.
        await lifecycle.toggle(target, { kind: 'continue', conversationSessionAddress: binding.conversationSessionAddress });
        expectedAttempt = getVoiceSessionPresentedAttemptId();
        await vi.waitFor(() => expect(expoSpeechSpeak.mock.calls.length,
          JSON.stringify({ snapshot: lifecycle.getSnapshot(), binding: voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId: lifecycle.getSnapshot().sessionId! }) }))
          .toBeGreaterThan(speechBeforeContinue));
        await vi.waitFor(() => expect(lifecycle.getSnapshot(), JSON.stringify(lifecycle.getSnapshot()))
          .toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true }));
      }
      if (carrierSettled || replacedReadout || readoutFailure) {
        // The OS returns a fresh artifact after the preceding turn or End.
        const { File } = await import('expo-file-system');
        const responseUri = 'file:///tmp/native-voice-permission-answer.m4a';
        new File(responseUri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(responseUri);
      }
      const startsBeforeAnswer = sessionRpcWithServerScope.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2).length;
      const speechBeforeAnswer = expoSpeechSpeak.mock.calls.length;
      const response = typedQuestion
        ? import('./localVoiceEngine').then(engine => engine.sendLocalVoiceAgentTextTurn(binding.controlSessionId, answer))
          .then(() => ({ status: 'completed' as const }))
        : executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} });
      if (replaceRequest) {
        await Promise.race([asrStarted.promise, response.then(result => {
          throw new Error(`Expected held response ASR, received ${JSON.stringify(result)}`);
        })]);
        const prior = storage.getState().sessions[carrierId]!;
        await applyLocalVoiceSessionAgentState({
          ...prior, agentStateVersion: (prior.agentStateVersion ?? 0) + 1,
          updatedAt: Math.max(Date.now(), prior.updatedAt + 1),
          agentState: {
            requests: { 'native-next': { tool: 'Write', arguments: { file_path: '/tmp/replacement-request' }, createdAt: Date.now() } },
            completedRequests: { 'native-write': { ...prior.agentState!.requests!['native-write'], status: 'approved', completedAt: Date.now() } },
          },
        });
        const { resolveVoiceContextSessionFromState } = await import('@/voice/context/resolveVoiceContextSession');
        const { listPendingSessionRequests } = await import('@/sync/domains/session/pending/listPendingSessionRequests');
        const nextSession = resolveVoiceContextSessionFromState(binding.conversationSessionAddress, storage.getState());
        expect(nextSession && listPendingSessionRequests(nextSession).map(request => request.id)).toEqual(['native-next']);
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot,
          snapshot => snapshot.mode === 'listening' && expoSpeechSpeak.mock.calls.length >= 2);
        asrHeld.resolve(answer);
      }
      expect(await response).toMatchObject({ status: 'completed' });
      if (responseFailure) {
        await submitted;
        const { t } = await import('@/text');
        expect(expoSpeechSpeak.mock.calls.at(-1)?.[0]).toBe(`${t('approvals.decisionError')} ${t('voice.readiness.permissionTapRequired')}`);
        expect(storage.getState().sessions[requestSessionId]?.agentState?.requests?.['native-write']).toBeDefined();
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL)).toBe(true);
        waiting.resolve();
        await expectNextCommitAccepted();
        return;
      }
      if (endAfterResponse) {
        expect(await executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        waiting.resolve();
        await submitted;
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected' });
        expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'unavailable' });
        return;
      }
      if (ordinaryQuestion) {
        const starts = sessionRpcWithServerScope.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
        expect(starts.slice(startsBeforeAnswer).map(([request]) => request.payload)).toContainEqual(expect.objectContaining({ message: expect.stringContaining(answer) }));
        expect(expoSpeechSpeak.mock.calls.slice(speechBeforeAnswer).map(([text]) => text)).toContain('Daemon reply');
        expect(storage.getState().sessions[actualRequestSessionId]?.agentState?.requests?.['native-write']).toBeDefined();
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        const { File } = await import('expo-file-system');
        const nextUri = 'file:///tmp/native-voice-after-unrelated-question.m4a';
        new File(nextUri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(nextUri);
        localVoiceSpeechTranscription.mockResolvedValueOnce('YES');
        const startsBeforeYes = starts.length;
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        expect(sessionRpcWithServerScope.mock.calls.filter(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2))
          .toHaveLength(startsBeforeYes + 1);
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        return;
      }
      if (approved === null) {
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'listening', canCommitInput: true });
        expect(expoSpeechSpeak.mock.calls).toHaveLength(precedingSpeechCount + 2);
        return;
      }
      expect(sessionRpcWithServerScope.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
        sessionId: actualRequestSessionId, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: expect.objectContaining({ id: 'native-write', ...(nativeOffer
          ? { nativeChoice: { requirementId: offeredChoices.requirementId, choiceId: approved ? 'accept' : nativeStop ? 'cancel' : 'decline' } }
          : { approved }) }),
      }));
      const originalResult = await submitted;
      if (nativeStop) {
        const { t } = await import('@/text');
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.canCommitInput === true
          && expoSpeechSpeak.mock.calls.some(([text]) => text === t('voice.readiness.permissionCommandStopped')));
      }
      if (carrierSettled || nativeStop) {
        const { t } = await import('@/text');
        const acknowledgement = expoSpeechSpeak.mock.calls.slice(precedingSpeechCount + 1).map(([text]) => text);
        expect(acknowledgement, JSON.stringify({ acknowledgement, snapshot: lifecycle.getSnapshot() }))
          .toContain(nativeStop ? t('voice.readiness.permissionCommandStopped')
            : approved ? t('approvals.status.approved') : t('approvals.status.rejected'));
        if (label === 'RUN113 Yes naming the command') {
          expect(acknowledgement, 'The person answered an already-read native request; no second read-back')
            .toEqual([t('approvals.status.approved')]);
        }
      }
      if (nativeStop) {
        expect(storage.getState().sessions[actualRequestSessionId]?.agentState?.completedRequests?.['native-write'])
          .toMatchObject({ status: 'denied', decision: 'abort' });
      }
      if (stoppedReady) {
        const { voiceHooks } = await import('@/voice/context/voiceHooks');
        const { createSessionMessagesFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
        const beforeReady = expoSpeechSpeak.mock.calls.length;
        const now = Date.now();
        storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
          [target.sessionId]: createSessionMessagesFixture({ messageIdsOldestFirst: ['progress', 'stopped-command'],
            messagesById: {
              progress: { kind: 'agent-text', id: 'progress', localId: null, createdAt: now - 2,
                text: 'I will request a new command approval before writing the file.' },
              'stopped-command': { kind: 'tool-call', id: 'stopped-command', localId: null, createdAt: now - 1,
                children: [], tool: { name: 'Bash', state: 'completed', input: {}, createdAt: now - 1,
                  startedAt: now - 1, completedAt: now, description: null,
                  permission: { id: 'native-write', status: 'denied', decision: 'abort',
                    nativeChoices: offeredChoices, nativeChoice: { requirementId: offeredChoices.requirementId, choiceId: 'cancel' } } } },
            }, isLoaded: true }),
        } }));
        voiceHooks.onReady(target, []);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(expoSpeechSpeak.mock.calls.slice(beforeReady)).toHaveLength(0);
      }
      if (syncedResult) {
        const { voiceHooks } = await import('@/voice/context/voiceHooks');
        const { buildRealtimeConversationTurnMeta } = await import('@/voice/transcript/VoiceTranscriptProjector');
        const resultText = 'The project root contains four hidden directories and no files.';
        const beforeResult = expoSpeechSpeak.mock.calls.length;
        if (resultPrivacyOff) storage.setState(state => ({ settings: { ...state.settings,
          voice: { ...state.settings.voice, privacy: { ...state.settings.voice.privacy, shareRecentMessages: false } },
        } }));
        const resultMessages = [{ kind: 'agent-text' as const, id: 'delegated-result', localId: null,
          createdAt: Date.now(), text: resultText }];
        const providerTurnsBeforeResult = sessionRpcWithServerScope.mock.calls.filter(([request]) =>
          request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2).length;
        if (readyOnly) {
          // Native completion can arrive as a Ready observation after its text
          // was already materialized, without another fresh message batch.
          const { createSessionMessagesFixture } = await import('@/dev/testkit/fixtures/transcriptFixtures');
          storage.setState(state => ({ sessionMessages: { ...state.sessionMessages,
            [target.sessionId]: createSessionMessagesFixture({ messageIdsOldestFirst: ['delegated-result'],
              messagesById: { 'delegated-result': resultMessages[0]! }, isLoaded: true }),
          } }));
          voiceHooks.onReady(target, []);
        } else {
          voiceHooks.onMessages(target, resultMessages);
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(expoSpeechSpeak.mock.calls.slice(beforeResult)).toHaveLength(0);
          voiceHooks.onReady(target, resultMessages);
        }
        const expectedReadout = resultPrivacyOff ? [] : [resultText];
        await new Promise<void>(resolve => setImmediate(resolve));
        await vi.waitFor(() => expect(expoSpeechSpeak.mock.calls.slice(beforeResult).map(([text]) => text)).toEqual(expectedReadout));
        await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.canCommitInput === true);
        voiceHooks.onMessages(binding.conversationSessionAddress, [{ kind: 'agent-text', id: 'spoken-result-echo', localId: null,
          createdAt: Date.now(), text: resultText, meta: buildRealtimeConversationTurnMeta() }]);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(expoSpeechSpeak.mock.calls.slice(beforeResult).map(([text]) => text)).toEqual(expectedReadout);
        expect(sessionRpcWithServerScope.mock.calls.filter(([request]) =>
          request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
          || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)).toHaveLength(providerTurnsBeforeResult);
      }
      if (continues === false) {
        expect(originalResult).toMatchObject({ error: { rpcErrorCode: turnError } });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', errorCode: 'provider_error' });
        expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        return;
      }
      if (!turnError && !readoutFailure) {
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL)).toBe(false);
        if (!replacedReadout) expect(expoSpeechSpeak.mock.calls.some(([text]) => text === 'Daemon reply')).toBe(true);
      }
      await expectNextCommitAccepted();
      if (!readoutFailure) expect(originalResult).toHaveProperty('result');
    } finally {
      asrHeld.resolve(answer);
      waiting.resolve();
      finishReadout?.();
      await submitted;
      await lifecycle.stop(lifecycle.getSnapshot().sessionId ?? target.sessionId);
      unsubscribe();
    }
  });
});
