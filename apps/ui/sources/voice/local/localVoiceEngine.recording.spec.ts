import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    machineRpcWithServerScope,
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

    it('throws when STT base URL is missing', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: '',
                            },
                        } },
                    },
                },
            },
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).rejects.toThrow('missing_stt_base_url');

        expect(globalThis.fetch).toHaveBeenCalledTimes(0);
        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('missing_stt_base_url');
    });

    it('resets to idle when STT request throws (network error)', async () => {
        (globalThis.fetch as any).mockRejectedValueOnce(new Error('network down'));

        const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(getLocalVoiceState().status).toBe('idle');
        expect(getLocalVoiceState().error).toBe('stt_failed');
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
            if (request?.method === RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE) {
                return {
                    ok: false,
                    error: 'request_timeout',
                    errorCode: 'request_timeout',
                    retryable: true,
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
