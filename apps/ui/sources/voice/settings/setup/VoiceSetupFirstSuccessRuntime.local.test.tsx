import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunEnsureOrStartRequestSchema } from '@happier-dev/protocol/execution/runs/index';
import { VoiceAgentTurnV1Schema } from '@happier-dev/protocol/messages/structured/voiceAgentTurnV1';
import { ExecutionRunTurnStreamStartV2RequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { SessionMessageRoleSchema } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';

import { renderScreen } from '@/dev/testkit';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    localVoiceHomeId,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    publishLocalVoiceAssistantMessage,
    publishLocalVoiceSubmittedUserMessage,
    publishLocalVoiceTranscriptMessage,
    registerLocalVoiceEngineHarnessHooks,
    sessionRpcWithServerScope,
    setLocalVoiceHttpResponder,
    waitForLocalVoiceBoundaryEvent,
    warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';

// Only microphone/recording, daemon RPC and Home HTTP/Socket are replaced by
// the shared harness. Capture, STT routing, Local send, Pending and Sync stay real.
const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreLoader());
const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
const { getVoiceSessionFirstSuccessAttemptId, getVoiceSessionPresentedAttemptId } = await import('@/voice/session/voiceSessionStore');
const { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } = await import('@/components/voice/attempt/useVoiceAttemptControl');
const { deriveVoiceSetupFacts } = await import('./voiceSetupFacts');

describe('first success through Local daemon speech and retained transcript', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('completes the real turn when the daemon reply is persisted before Pending settles its input', async () => {
        const storage = await getStorage();
        const config = readLocalConversationVoiceSettings(storage.getState().settings.voice);
        storage.__setState({ settings: { ...storage.getState().settings, voice: {
            ...storage.getState().settings.voice,
            providerId: 'local_conversation',
            executionMachine: { mode: 'fixed', machineId: 'machine-1' },
            providers: { ...storage.getState().settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
                ...config, conversationMode: 'agent',
                stt: { ...config.stt, baseUrl: 'http://localhost:8000' },
                tts: { ...config.tts, autoSpeakReplies: false },
                agent: { ...config.agent, prewarmOnConnect: false },
                streaming: { ...config.streaming, enabled: true, ttsEnabled: false },
            } } },
        } } });
        const incumbent = sessionRpcWithServerScope.getMockImplementation();
        if (!incumbent) throw new Error('Expected real Socket RPC boundary');
        let conversationId: string | null = null;
        sessionRpcWithServerScope.mockImplementation(async request => {
            if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
                const input = ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload);
                conversationId = request.sessionId;
                expect(input.userTranscript).toMatchObject({ mode: 'suppress' });
                // Run 33: stream-start can finish the reply before its ACK
                // lets the UI settle the already-admitted Pending input.
                await publishLocalVoiceAssistantMessage({ sessionId: request.sessionId,
                    id: 'first-local-reply', localId: 'stream-1:assistant', text: 'Daemon reply',
                    meta: { happier: { kind: 'voice_agent_turn.v1', payload: VoiceAgentTurnV1Schema.parse({
                        v: 1, epoch: 0, role: 'assistant', voiceAgentId: input.runId,
                        runId: input.runId, streamId: 'stream-1', ts: Date.now(),
                    }) } },
                });
            }
            return incumbent(request);
        });
        setLocalVoiceHttpResponder(async request => {
            const messagesPost = /^\/v2\/sessions\/([^/]+)\/messages$/.exec(request.path);
            if (messagesPost && request.method === 'POST') {
                const input = z.strictObject({ localId: z.string(),
                    content: StrictSessionStoredMessageContentEnvelopeSchema, messageRole: SessionMessageRoleSchema,
                }).parse(request.body);
                if (input.messageRole !== 'user' && input.messageRole !== 'agent') {
                    throw new Error('Expected a Voice transcript message');
                }
                const message = await publishLocalVoiceTranscriptMessage({ ...input,
                    messageRole: input.messageRole,
                    sessionId: decodeURIComponent(messagesPost[1]!), id: `message-${input.localId}` });
                return Response.json({ didWrite: true, message });
            }
            if (!request.path.endsWith('/delivery/handled')) return undefined;
            const admitted = localVoicePendingEnqueue.mock.calls.at(-1)?.[0];
            if (!admitted) throw new Error('Expected admitted speech input');
            await publishLocalVoiceSubmittedUserMessage(admitted);
            return Response.json({});
        });
        localVoiceSpeechTranscription.mockResolvedValueOnce('hello from daemon speech');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl);
        if (!credentials) throw new Error('Expected restored Account');
        let firstSuccess: ReturnType<typeof useVoiceAttemptControl>['firstSuccessEvent'] = null;
        function Scene() {
            firstSuccess = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL).firstSuccessEvent;
            return <VoiceSessionRuntime />;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Scene /></InjectedAuthProvider>);
        const lifecycle = getVoiceSessionLifecycleController();
        if (!lifecycle) throw new Error('Expected mounted lifecycle');
        const acquisitions = () => sessionRpcWithServerScope.mock.calls.map(([request]) => request).filter(request =>
            request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1);
        const modelTurns = () => sessionRpcWithServerScope.mock.calls.map(([request]) => request).filter(request =>
            request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
            || request.method === SESSION_RPC_METHODS.EXECUTION_RUN_ACTION);
        try {
            expect(acquisitions()).toHaveLength(0);
            expect(modelTurns()).toHaveLength(0);
            await act(async () => { await lifecycle.toggle({ serverId: localVoiceHomeId, sessionId: 's1' }); });
            await waitForLocalVoiceBoundaryEvent('agent-start');
            expect(acquisitions()).toHaveLength(1);
            expect(ExecutionRunEnsureOrStartRequestSchema.parse(acquisitions()[0]?.payload).start?.bootstrapMode).toBe('none');
            expect(modelTurns()).toHaveLength(0);
            expect(getVoiceSessionFirstSuccessAttemptId()).toBeNull();
            const attemptId = getVoiceSessionPresentedAttemptId();
            expect(attemptId).not.toBeNull();
            const engine = await loadLocalVoiceEngineWithCompatState();
            await act(async () => { await engine.toggleLocalVoiceTurn('s1'); });
            expect(localVoiceSpeechTranscription).toHaveBeenCalledWith(expect.objectContaining({ uploadId: 'local-engine-test-upload' }));
            expect(conversationId).not.toBeNull();
            expect(acquisitions()).toHaveLength(1);
            const messages = readStoredSessionMessages(storage.getState(), conversationId!);
            const input = messages.find(message => message.kind === 'user-text');
            const reply = messages.find(message => message.kind === 'agent-text' && message.localId === 'stream-1:assistant');
            expect(input).toMatchObject({ kind: 'user-text', text: 'hello from daemon speech' });
            expect(input?.seq).toBeGreaterThan(reply?.seq ?? Infinity);
            expect(deriveVoiceSetupFacts({ providerId: 'local_conversation', readiness: null,
                microphonePermission: 'granted', messages }).firstTurnComplete).toBe(true);
            expect(getVoiceSessionFirstSuccessAttemptId()).toBe(attemptId);
            expect(firstSuccess).toEqual({ kind: 'gather', id: `${attemptId}:first-success` });
            expect(localVoiceHomeId).toBe(getActiveServerSnapshot().serverId);
        } finally {
            await act(async () => { await lifecycle.stop('__voice_agent__'); });
            await screen.unmount();
            await lifecycle.dispose();
        }
    });
});
