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
            preferredExecution: 'daemon',
            requestedExecution: 'device',
            selectableExecution: 'daemon',
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

    it('clamps explicit device execution to daemon on web when daemon inference is enabled', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(true);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'device' })).resolves.toBe('daemon');
    });

    it('falls back to device execution when daemon inference is disabled', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockResolvedValue(false);

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).resolves.toBe('device');
    });

    it('fails closed to device execution when the daemon-inference feature probe errors', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        isRuntimeFeatureEnabledMock.mockRejectedValue(new Error('feature probe failed'));

        const { resolveDaemonVoiceInferenceExecution } = await import('./daemonVoiceInferencePolicy');

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).resolves.toBe('device');
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

    it('demotes a conversation to device execution after two consecutive over-budget daemon synthesis samples', async () => {
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
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-1' })).resolves.toBe('device');

        clearDaemonVoiceInferenceLatencyState('session-1');
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

        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto', sessionId: 'session-3' })).resolves.toBe('device');

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
