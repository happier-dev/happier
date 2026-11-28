import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceSpeechTranscribeRequestSchema, DaemonVoiceSpeechTranscribeResponseSchema } from '@happier-dev/protocol/daemon/voiceSpeech';
import { createDeferred } from '@/dev/testkit';

import {
    getStorage,
    fileDelete,
    loadLocalVoiceEngineWithCompatState,
    machineRpcWithServerScope,
    emitSpeechRecEvent,
    speechRecStop,
    speechRecStart,
    localVoicePendingEnqueue,
    localVoiceSpeechTranscription,
    localVoiceSpeechOutputBoundary,
    registerLocalVoiceEngineHarnessHooks,
    readLocalVoiceMachinePrerequisites,
    setRecorderUri,
    setNextRecorderPrepareError,
} from './localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine recording lifecycle', () => {
    registerLocalVoiceEngineHarnessHooks();

    it.each([
        ['HE BEGAN A CONFUSED COMPLAINT AGAINST THE WIZARD.', 'He began a confused complaint against the wizard.'],
        ['Open README.md for API', 'Open README.md for API'],
    ])('persists normalized recorded speech: %s', async (transcript, expected) => {
        localVoiceSpeechTranscription.mockResolvedValueOnce(transcript);
        const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');
        expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                role: 'user', content: { type: 'text', text: expected },
            }) } }),
        }));
    });

    it('cleans up and reports an error when recording initialization fails', async () => {
        setNextRecorderPrepareError(new Error('prepare failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('prepare failed');
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('recording_start_failed');
    });

    it('keeps the daemon-selected STT provider failure observable after recorded capture', async () => {
        const fallback = machineRpcWithServerScope.getMockImplementation();
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            if (request?.method === RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE) {
                const input = DaemonVoiceSpeechTranscribeRequestSchema.parse(request.payload);
                expect(input.target).toMatchObject({ pluginId: 'happier.voice.openai-compat', localId: 'stt' });
                return DaemonVoiceSpeechTranscribeResponseSchema.parse({ ok: false, errorCode: 'provider_unavailable' });
            }
            if (!fallback) throw new Error('missing local voice machine RPC fallback');
            return await fallback(request);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(localVoiceSpeechTranscription).toHaveBeenCalledTimes(0);
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_provider_unavailable');
    });

    it('resets to idle when STT request throws (network error)', async () => {
        localVoiceSpeechTranscription.mockRejectedValueOnce(new Error('network down'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
        expect(fileDelete).toHaveBeenCalledOnce();
    });

    it('surfaces a failed recorded-audio cleanup instead of silently treating the attempt as clean', async () => {
        fileDelete.mockImplementationOnce(() => { throw new Error('recording_delete_failed'); });
        localVoiceSpeechTranscription.mockResolvedValueOnce('');

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(fileDelete).toHaveBeenCalledOnce();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            error: 'recording_cleanup_failed',
        });
    });

    it('keeps a recorded-audio cleanup failure visible when End Voice interrupts native finalization', async () => {
        const cleanupFailure = new Error('recording_delete_failed');
        const finalizationStarted = createDeferred<void>();
        const finalizedRecording = createDeferred<{ uri: string }>();
        localVoiceSpeechOutputBoundary.fileRecording.stop.mockImplementationOnce(() => {
            finalizationStarted.resolve();
            return finalizedRecording.promise;
        });
        fileDelete.mockImplementationOnce(() => { throw cleanupFailure; });

        const {
            getLocalVoiceState,
            stopLocalVoiceSession,
            toggleLocalVoiceTurn,
        } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        const stopAndTranscribe = toggleLocalVoiceTurn('s1');
        await finalizationStarted.promise;

        // The native owner joins recording retirement before publishing End.
        const ending = stopLocalVoiceSession();
        finalizedRecording.resolve({ uri: 'file:///tmp/rec.m4a' });
        await expect(ending).resolves.toBeUndefined();
        await expect(stopAndTranscribe).resolves.toBeUndefined();

        expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
        expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
        expect(fileDelete).toHaveBeenCalledOnce();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            error: 'recording_cleanup_failed',
        });
    });

    it('keeps recorded-audio transcription on the admitted STT settings after a mid-capture setting change', async () => {
        const storage = await getStorage();
        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        const beforeCapture = await readLocalVoiceMachinePrerequisites();
        await toggleLocalVoiceTurn('s1');

        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_direct',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_direct: {
                            ...storage.getState().settings.voice.providers.local_direct,
                            config: {
                                ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
                                stt: {
                                    ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                                    provider: 'device',
                                },
                            },
                        },
                    },
                },
            },
        });
        localVoiceSpeechTranscription.mockResolvedValueOnce('');
        speechRecStop.mockImplementation(() => {
            queueMicrotask(() => emitSpeechRecEvent('end', {}));
        });

        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(localVoiceSpeechTranscription, JSON.stringify({
            beforeCapture, afterCapture: await readLocalVoiceMachinePrerequisites(), state: getLocalVoiceState(),
        })).toHaveBeenCalledWith(expect.objectContaining({
            target: { pluginId: 'happier.voice.openai-compat', localId: 'stt' },
        }));
        expect(speechRecStart).not.toHaveBeenCalled();
        expect(fileDelete).toHaveBeenCalledOnce();
    });

    it('surfaces a missing finalized recording URI instead of silently completing an empty turn', async () => {
        setRecorderUri(null);

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('recording_uri_missing');
    });

    it('maps a daemon STT request timeout to a recoverable idle failure', async () => {
        const fallback = machineRpcWithServerScope.getMockImplementation();
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            if (request?.method === RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE) {
                return {
                    ok: false,
                    errorCode: 'request_timeout',
                };
            }
            if (!fallback) throw new Error('missing local voice machine RPC fallback');
            return await fallback(request);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_request_timeout');
    });


});
