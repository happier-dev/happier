import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    getStorage,
    fileDelete,
    loadLocalVoiceEngineWithCompatState,
    machineRpcWithServerScope,
    emitSpeechRecEvent,
    speechRecStop,
    registerLocalVoiceEngineHarnessHooks,
    setRecorderUri,
    setNextRecorderPrepareError,
} from './localVoiceEngine.testHarness';

describe('local voice engine recording lifecycle', () => {
    registerLocalVoiceEngineHarnessHooks();

    it('cleans up and reports an error when recording initialization fails', async () => {
        setNextRecorderPrepareError(new Error('prepare failed'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('prepare failed');
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('recording_start_failed');
    });

    it('maps a blank qualified STT endpoint to the daemon provider failure', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        'happier.voice.openai-compat/stt': { schemaVersion: 2, config: {
                            ...storage.getState().settings.voice.providers['happier.voice.openai-compat/stt'].config,
                            baseUrl: '',
                        } },
                    },
                },
            },
        });
        const fallback = machineRpcWithServerScope.getMockImplementation();
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            if (request?.method === RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE) {
                return { ok: false, errorCode: 'provider_unavailable' };
            }
            if (!fallback) throw new Error('missing local voice machine RPC fallback');
            return await fallback(request);
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(globalThis.fetch).toHaveBeenCalledTimes(0);
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_provider_unavailable');
    });

    it('resets to idle when STT request throws (network error)', async () => {
        (globalThis.fetch as any).mockRejectedValueOnce(new Error('network down'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
        expect(fileDelete).toHaveBeenCalledOnce();
    });

    it('surfaces a failed recorded-audio cleanup instead of silently treating the attempt as clean', async () => {
        fileDelete.mockRejectedValueOnce(new Error('recording_delete_failed'));
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: '' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(fileDelete).toHaveBeenCalledOnce();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            error: 'recording_cleanup_failed',
        });
    });

    it('keeps recorded-audio transcription on the admitted STT settings after a mid-capture setting change', async () => {
        const storage = await getStorage();
        const { toggleLocalVoiceTurn } = await loadLocalVoiceEngineWithCompatState();
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
                                ...storage.getState().settings.voice.providers.local_direct.config,
                                stt: {
                                    ...storage.getState().settings.voice.providers.local_direct.config.stt,
                                    provider: 'device',
                                },
                            },
                        },
                    },
                },
            },
        });
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: '' }),
        });
        speechRecStop.mockImplementation(() => {
            queueMicrotask(() => emitSpeechRecEvent('end', {}));
        });

        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://localhost:8000/v1/audio/transcriptions',
            expect.objectContaining({ method: 'POST' }),
        );
        expect(fileDelete).toHaveBeenCalledOnce();
    });

    it('surfaces a missing finalized recording URI instead of silently completing an empty turn', async () => {
        setRecorderUri(null);

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(globalThis.fetch).not.toHaveBeenCalled();
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

    it('delegates recorder-backed mic ownership to LocalVoiceCaptureOwner instead of concrete recorder creation in localVoiceEngine', async () => {
        const startCapture = vi.fn(async () => {});

        vi.doMock('@/voice/input/DeviceSttController', () => ({
            createDeviceSttController: () => {
                throw new Error('localVoiceEngine should not create DeviceSttController directly');
            },
        }));
        vi.doMock('@/voice/input/SherpaStreamingSttController', () => ({
            createSherpaStreamingSttController: () => {
                throw new Error('localVoiceEngine should not create SherpaStreamingSttController directly');
            },
        }));
        vi.doMock('@/voice/runtime/mic/NativeMicSession', () => ({
            createNativeMicSession: () => ({
                ensureActive: async () => {},
                setMuted: () => {},
                isMuted: () => false,
                teardown: async () => {},
                getStream: () => null,
            }),
            createExpoAudioRecordingMicSession: () => {
                throw new Error('localVoiceEngine should not create NativeMicSession directly');
            },
        }));
        vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
            createLocalVoiceCaptureOwner: () => ({
                resolveManualBargeInAction: vi.fn(() => ({
                    kind: 'start_capture',
                    sessionId: 's1',
                    provider: 'recorded_audio',
                    handsFree: false,
                })),
                resolveEndpointSignalAction: vi.fn(() => ({ kind: 'ignore', reason: 'not_recording' })),
                startCapture,
                stopCapture: vi.fn(async () => ({ provider: 'recorded_audio', uri: 'file:///tmp/rec.m4a' })),
                clearHandsFree: vi.fn(),
                stopSession: vi.fn(async () => {}),
            }),
        }));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');

        expect(startCapture).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            provider: 'recorded_audio',
        }));
        expect(getLocalVoiceState()).toMatchObject({
            status: 'recording',
            sessionId: 's1',
            error: null,
        });
    });
});
