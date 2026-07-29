import { beforeEach, describe, expect, it, vi } from 'vitest';

const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (...args: any[]) => isRuntimeFeatureEnabledMock(...args),
}));

describe('resolveDaemonVoiceInferenceExecution', () => {
    beforeEach(() => {
        vi.resetModules();
        isRuntimeFeatureEnabledMock.mockReset();
    });

    it('derives one shared local_neural execution policy for web selection and default routing', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));

        const { resolveLocalNeuralExecutionPolicy } = await import('./daemonVoiceInferencePolicy');

        expect(resolveLocalNeuralExecutionPolicy({ requestedExecution: 'device' })).toEqual({
            allowDeviceSelection: false,
            preferredExecution: 'device',
            requestedExecution: 'device',
            selectableExecution: 'device',
        });

        expect(resolveLocalNeuralExecutionPolicy({ requestedExecution: 'auto' })).toEqual({
            allowDeviceSelection: false,
            preferredExecution: 'daemon',
            requestedExecution: 'auto',
            selectableExecution: 'auto',
        });
    });

    it('prefers daemon execution for auto on web when daemon inference is enabled', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto' })).resolves.toBe('daemon');
    });

    it('keeps explicit device execution on web instead of changing execution authority', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'device' })).resolves.toBe('device');
        expect(isRuntimeFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it('returns a typed unavailable error for explicit daemon execution when daemon inference is disabled', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(false);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).rejects.toMatchObject({
            code: 'feature_disabled',
            message: 'daemon_voice_inference_feature_disabled',
        });
    });

    it('returns a typed error for explicit daemon execution when the feature probe errors', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockRejectedValue(new Error('feature probe failed'));

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).rejects.toMatchObject({
            code: 'internal_error',
            message: 'daemon_voice_inference_feature_probe_failed',
        });
    });

    it('keeps explicit device execution on native', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'device' })).resolves.toBe('device');
    });

    it('keeps auto execution on the native device branch when daemon inference is enabled', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto' })).resolves.toBe('device');
    });

    it('does not demote web auto execution to an unavailable device location after over-budget samples', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const {
            resolveDaemonVoiceInferenceExecution,
            recordDaemonVoiceInferenceTtsLatencySample,
            clearDaemonVoiceInferenceLatencyState,
        } = await import('./daemonVoiceInferencePolicy');

        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-1', elapsedMs: 3_000 });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-1' })).resolves.toBe('daemon');

        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-1', elapsedMs: 3_000 });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-1' })).resolves.toBe('daemon');

        clearDaemonVoiceInferenceLatencyState('session-1');
    });

    it('does not demote an explicit daemon selection after over-budget synthesis samples', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const {
            resolveDaemonVoiceInferenceExecution,
            recordDaemonVoiceInferenceTtsLatencySample,
            clearDaemonVoiceInferenceLatencyState,
        } = await import('./daemonVoiceInferencePolicy');

        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-explicit', elapsedMs: 3_000 });
        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-explicit', elapsedMs: 3_000 });

        await expect(resolveDaemonVoiceInferenceExecution({
            requestedExecution: 'daemon',
            sessionId: 'session-explicit',
        })).resolves.toBe('daemon');

        clearDaemonVoiceInferenceLatencyState('session-explicit');
    });

    it('resets daemon latency demotion tracking after an in-budget synthesis sample', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const {
            resolveDaemonVoiceInferenceExecution,
            recordDaemonVoiceInferenceTtsLatencySample,
            clearDaemonVoiceInferenceLatencyState,
        } = await import('./daemonVoiceInferencePolicy');

        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-2', elapsedMs: 3_000 });
        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-2', elapsedMs: 100 });
        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-2', elapsedMs: 3_000 });

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-2' })).resolves.toBe('daemon');

        clearDaemonVoiceInferenceLatencyState('session-2');
    });

    it('clears daemon latency demotion when the active voice session disconnects', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const {
            resolveDaemonVoiceInferenceExecution,
            recordDaemonVoiceInferenceTtsLatencySample,
            clearDaemonVoiceInferenceLatencyState,
        } = await import('./daemonVoiceInferencePolicy');
        const { setVoiceSessionSnapshot } = await import('../../session/voiceSessionStore');

        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-3', elapsedMs: 3_000 });
        recordDaemonVoiceInferenceTtsLatencySample({ sessionId: 'session-3', elapsedMs: 3_000 });

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-3' })).resolves.toBe('daemon');

        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'session-3',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-3' })).resolves.toBe('daemon');

        clearDaemonVoiceInferenceLatencyState('session-3');
    });
});
