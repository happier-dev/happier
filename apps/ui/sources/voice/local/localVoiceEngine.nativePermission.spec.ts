import { afterAll, describe, expect, it } from 'vitest';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, waitForTestEvent } from '@/dev/testkit';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  getStorage, localVoiceHomeId, localVoiceSpeechTranscription, expoSpeechSpeak,
  setRecorderUri,
  registerLocalVoiceEngineHarnessHooks, sessionRpcWithServerScope,
  waitForLocalVoiceBoundaryEvent, warmLocalVoiceEngineHarnessGraph,
} from './localVoiceEngine.testHarness';

const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreLoader());

describe('native Voice permission input', () => {
  registerLocalVoiceEngineHarnessHooks();

  it.each([
    { label: 'Yes', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false },
    { label: 'No', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false },
    { label: 'delegated Yes', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true },
    { label: 'delegated No', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, delegated: true },
    { label: 'delegated Yes after the carrier turn settles', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'delegated No after the carrier turn settles', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, delegated: true, carrierSettled: true },
    { label: 'a failed delegated response', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, delegated: true, responseFailure: true },
    { label: 'No followed by native execution rejection', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', continues: true },
    { label: 'End after No before native execution rejection', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', endAfterResponse: true },
    { label: 'Yes followed by native execution rejection', enabled: true, answer: 'Yes.', approved: true, end: false, replaceRequest: false, turnError: 'claude_error_during_execution', continues: false },
    { label: 'No followed by lost transport', enabled: true, answer: 'No.', approved: false, end: false, replaceRequest: false, turnError: 'target_unavailable', continues: false },
    { label: 'an ordinary turn', enabled: true, answer: '', approved: null, end: false, replaceRequest: false },
    { label: 'provider quota before tools', enabled: true, answer: '', approved: null, end: false, replaceRequest: false, turnError: 'usage_limit', providerFailure: true },
    { label: 'End before provider quota settles', enabled: true, answer: '', approved: null, end: true, replaceRequest: false, turnError: 'usage_limit', providerFailure: true },
    { label: 'approval opt-out', enabled: false, answer: 'Yes.', approved: null, end: false, replaceRequest: false },
    { label: 'an unclear answer', enabled: true, answer: 'Yes, but no.', approved: null, end: false, replaceRequest: false },
    { label: 'an empty transcript', enabled: true, answer: '', approved: null, end: false, replaceRequest: false },
    { label: 'End', enabled: true, answer: '', approved: null, end: true, replaceRequest: false },
    { label: 'a replacement request while ASR is pending', enabled: true, answer: 'Yes.', approved: null, end: false, replaceRequest: true },
  ])('reads a native permission aloud and respects $label', async ({ label, enabled, answer, approved, end, replaceRequest, turnError, continues, endAfterResponse, providerFailure, delegated, carrierSettled, responseFailure }) => {
    const storage = await getStorage();
    const state = storage.getState();
    const config = readLocalConversationVoiceSettings(state.settings.voice);
    storage.__setState({ settings: { ...state.settings, voice: {
      ...state.settings.voice, providerId: 'local_conversation', canApproveRequests: enabled,
      welcome: { ...state.settings.voice.welcome, enabled: false },
      providers: { ...state.settings.voice.providers, local_conversation: { schemaVersion: 1,
        config: { ...config, conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: false },
          streaming: { ...config.streaming, enabled: true },
          tts: { ...config.tts, provider: 'device', autoSpeakReplies: true } },
      } },
    } } });
    const asrStarted = createDeferred<void>();
    const asrHeld = createDeferred<string>();
    localVoiceSpeechTranscription.mockResolvedValueOnce('Write the requested file.');
    if (label !== 'an ordinary turn' && !providerFailure) {
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
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
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
            error: 'Native Agent session turn failed' }], nextCursor: 1, done: true };
        }
      }
      if (request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND) {
        if (responseFailure) throw Object.assign(new Error('Permission transport unavailable'), { rpcErrorCode: 'target_unavailable' });
        // Publish the daemon's answered-request update as well as its RPC result.
        const carrier = storage.getState().sessions[request.sessionId]!;
        const pending = carrier.agentState!.requests!['native-write'];
        storage.getState().applySessions([{
          ...carrier, agentStateVersion: (carrier.agentStateVersion ?? 0) + 1,
          updatedAt: Math.max(Date.now(), carrier.updatedAt + 1),
          agentState: { ...carrier.agentState, requests: {}, completedRequests: {
            ...carrier.agentState?.completedRequests,
            'native-write': { ...pending, status: approved ? 'approved' : 'denied', completedAt: Date.now() },
          } },
        }]);
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
    try {
      await lifecycle.toggle(target);
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
      const expectedAttempt = getVoiceSessionPresentedAttemptId();
      const expectNextCommitAccepted = async () => {
        expect(lifecycle.getSnapshot(), JSON.stringify(lifecycle.getSnapshot())).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
        // Native recorders produce a fresh file; the preceding turn deleted its artifact.
        const { File } = await import('expo-file-system');
        const nextRecordingUri = 'file:///tmp/native-voice-followup.m4a';
        new File(nextRecordingUri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(nextRecordingUri);
        localVoiceSpeechTranscription.mockResolvedValueOnce('Continue the conversation.');
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'completed' });
        await expect(localVoiceSpeechTranscription.mock.results.at(-1)?.value).resolves.toBe('Continue the conversation.');
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', canCommitInput: true });
      };
      submitted = executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} })
        .then(result => ({ result }), error => ({ error }));
      await Promise.race([waitForLocalVoiceBoundaryEvent('stream-start'), submitted.then(result => {
        throw new Error(`Expected waiting native turn, received ${JSON.stringify(result)}`);
      })]);
      const binding = voiceSessionBindingStore.getState().getByControlSessionId(lifecycle.getSnapshot().sessionId!);
      if (!binding) throw new Error('Expected native Voice conversation');
      expect(binding.transcriptMode).toBe('native_session');
      expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'thinking' });
      expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
        .toMatchObject({ status: 'unavailable', code: 'voice_commit_unavailable' });
      if (label === 'an ordinary turn') {
        waiting.resolve();
        await submitted;
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
          expect(expoSpeechSpeak.mock.calls.map(([text]) => text)).toEqual([t('session.usageLimitRecovery.banner.title')]);
          await expectNextCommitAccepted();
        }
        return;
      }
      const carrierId = binding.conversationSessionAddress.sessionId;
      const requestSessionId = delegated ? target.sessionId : carrierId;
      if (carrierSettled) {
        waiting.resolve();
        await submitted;
      }
      const precedingSpeechCount = expoSpeechSpeak.mock.calls.length;
      const carrier = storage.getState().sessions[requestSessionId]!;
      storage.getState().applySessions([{
        ...carrier, active: true, agentStateVersion: (carrier.agentStateVersion ?? 0) + 1,
        updatedAt: Math.max(Date.now(), carrier.updatedAt + 1),
        agentState: { requests: { 'native-write': { tool: 'Write', arguments: { file_path: '/tmp/native-voice-test' }, createdAt: Date.now() } } },
      }]);
      // A tap-only projection leaves the original turn Thinking and never speaks.
      await waitForLocalVoiceBoundaryEvent('speech', precedingSpeechCount + 1);
      expect(expoSpeechSpeak.mock.calls[precedingSpeechCount]?.[0]).toContain('permission');
      if (!enabled) {
        expect(await executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} }))
          .toMatchObject({ status: 'unavailable', code: 'voice_commit_unavailable' });
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
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
      if (carrierSettled) {
        // The original turn consumed its recording; the OS returns a fresh
        // artifact for the permission answer captured after that turn.
        const { File } = await import('expo-file-system');
        const responseUri = 'file:///tmp/native-voice-permission-answer.m4a';
        new File(responseUri).write(new Uint8Array([1, 2, 3]));
        setRecorderUri(responseUri);
      }
      const response = executeVoiceConversationAction('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' }, { navigate() {} });
      if (replaceRequest) {
        await Promise.race([asrStarted.promise, response.then(result => {
          throw new Error(`Expected held response ASR, received ${JSON.stringify(result)}`);
        })]);
        const prior = storage.getState().sessions[carrierId]!;
        storage.getState().applySessions([{
          ...prior, agentStateVersion: (prior.agentStateVersion ?? 0) + 1,
          updatedAt: Math.max(Date.now(), prior.updatedAt + 1),
          agentState: {
            requests: { 'native-next': { tool: 'Write', arguments: { file_path: '/tmp/replacement-request' }, createdAt: Date.now() } },
            completedRequests: { 'native-write': { ...prior.agentState!.requests!['native-write'], status: 'approved', completedAt: Date.now() } },
          },
        }]);
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
      if (approved === null) {
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === RPC_METHODS.SESSION_PERMISSION_RESPOND)).toBe(false);
        expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'listening', canCommitInput: true });
        expect(expoSpeechSpeak.mock.calls).toHaveLength(2);
        return;
      }
      const originalResult = await submitted;
      expect(sessionRpcWithServerScope.mock.calls.map(([request]) => request)).toContainEqual(expect.objectContaining({
        sessionId: requestSessionId, method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
        payload: expect.objectContaining({ id: 'native-write', approved }),
      }));
      if (continues === false) {
        expect(originalResult).toMatchObject({ error: { rpcErrorCode: turnError } });
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', errorCode: 'provider_error' });
        expect(lifecycle.getSnapshot().canCommitInput).not.toBe(true);
        return;
      }
      if (!turnError) {
        expect(sessionRpcWithServerScope.mock.calls.some(([request]) => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL)).toBe(false);
        expect(expoSpeechSpeak.mock.calls.some(([text]) => text === 'Daemon reply')).toBe(true);
      }
      await expectNextCommitAccepted();
      expect(originalResult).toHaveProperty('result');
    } finally {
      asrHeld.resolve(answer);
      waiting.resolve();
      await submitted;
      await lifecycle.stop(target.sessionId);
      unsubscribe();
    }
  });
});
