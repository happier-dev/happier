import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_RUNTIME_WARM_DEFAULTS } from '@happier-dev/protocol';

const ensureVoiceConversationSessionForVoiceHomeMock = vi.hoisted(() => vi.fn());
const resolveVoiceHomeDaemonMachineIdMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const resolveDaemonVoiceInferenceExecutionMock = vi.hoisted(() => vi.fn());

vi.mock('@/voice/persistence/voiceConversationSession', () => ({
    ensureVoiceConversationSessionForVoiceHome: (...args: unknown[]) =>
        ensureVoiceConversationSessionForVoiceHomeMock(...args),
    resolveVoiceHomeDaemonMachineId: (...args: unknown[]) => resolveVoiceHomeDaemonMachineIdMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('./daemonVoiceInferencePolicy', () => ({
    resolveDaemonVoiceInferenceExecution: (...args: unknown[]) =>
        resolveDaemonVoiceInferenceExecutionMock(...args),
}));

describe('warmDaemonVoiceInferenceOnVoiceHomeAttach', () => {
    beforeEach(() => {
        vi.resetModules();
        ensureVoiceConversationSessionForVoiceHomeMock.mockReset();
        resolveVoiceHomeDaemonMachineIdMock.mockReset();
        readMachineTargetForSessionMock.mockReset();
        machineRpcWithServerScopeMock.mockReset();
        resolveDaemonVoiceInferenceExecutionMock.mockReset();

        ensureVoiceConversationSessionForVoiceHomeMock.mockRejectedValue(
            new Error('voice-home session must not gate daemon model warmup'),
        );
        resolveVoiceHomeDaemonMachineIdMock.mockReturnValue('machine-selected');
        readMachineTargetForSessionMock.mockReturnValue({
            machineId: 'machine-unrelated',
            basePath: '/unrelated-session',
        });
        machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, models: [] });
        resolveDaemonVoiceInferenceExecutionMock.mockResolvedValue('daemon');
    });

    it('warms local Voice models on the selected daemon without spawning an unrelated agent session', async () => {
        const { warmDaemonVoiceInferenceOnVoiceHomeAttach } = await import(
            './warmDaemonVoiceInferenceOnVoiceHomeAttach'
        );

        await expect(
            warmDaemonVoiceInferenceOnVoiceHomeAttach({
                settings: {
                    voice: {
                        providerId: 'local_conversation',
                        providers: {
                            local_conversation: {
                                schemaVersion: 1,
                                config: {
                                    stt: {
                                        provider: 'local_neural',
                                        localNeural: {
                                            execution: 'daemon',
                                            assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                sessionId: 'synthetic-qa-session',
            }),
        ).resolves.toBeUndefined();

        expect(resolveVoiceHomeDaemonMachineIdMock).toHaveBeenCalledTimes(1);
        expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
        expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith({
            machineId: 'machine-selected',
            method: 'daemon.voiceInference.models.warm',
            payload: {
                packIds: ['sherpa-onnx-streaming-zipformer-en-20M-2023-02-17'],
            },
            timeoutMs: VOICE_RUNTIME_WARM_DEFAULTS.warmRequestTimeoutMs,
        });
    });

    it('rejects a structured daemon warm failure instead of treating it as a successful warm', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: false,
            errorCode: 'model_not_installed',
            error: 'daemon_voice_inference_model_not_installed',
            retryable: false,
        });
        const { warmDaemonVoiceInferenceOnVoiceHomeAttach } = await import(
            './warmDaemonVoiceInferenceOnVoiceHomeAttach'
        );

        await expect(
            warmDaemonVoiceInferenceOnVoiceHomeAttach({
                settings: {
                    voice: {
                        providerId: 'local_conversation',
                        providers: {
                            local_conversation: {
                                schemaVersion: 1,
                                config: {
                                    stt: {
                                        provider: 'local_neural',
                                        localNeural: {
                                            execution: 'daemon',
                                            assetId: 'stt-pack-missing',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                sessionId: 'voice-home-session',
            }),
        ).rejects.toMatchObject({
            code: 'model_not_installed',
            message: 'daemon_voice_inference_model_not_installed',
        });
    });
});
