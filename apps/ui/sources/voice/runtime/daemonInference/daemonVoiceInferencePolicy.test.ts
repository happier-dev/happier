import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveDaemonVoiceInferenceExecution, resolveLocalNeuralExecutionPolicy } from './daemonVoiceInferencePolicy';

// Only the platform SDK boundary changes; stored settings and feature decisions stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
const initialState = storage.getState();
beforeEach(() => {
    Platform.OS = 'web';
    storage.getState().applySettingsLocal({ experiments: true, featureToggles: {
        voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
    } });
    primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId, snapshot: {
        status: 'ready', features: FeaturesResponseSchema.parse({
            features: { voice: { enabled: true }, execution: { runs: { enabled: true } } }, capabilities: {},
        }),
    } });
});
afterEach(() => { storage.setState(initialState, true); resetServerFeaturesClientForTests(); });

describe('daemon inference policy with real feature decisions', () => {
    it('derives one shared local-neural selection policy on web', () => {
        expect(resolveLocalNeuralExecutionPolicy({ requestedExecution: 'device' })).toEqual({
            allowDeviceSelection: false, preferredExecution: 'device', requestedExecution: 'device', selectableExecution: 'device',
        });
        expect(resolveLocalNeuralExecutionPolicy({ requestedExecution: 'auto' })).toEqual({
            allowDeviceSelection: false, preferredExecution: 'daemon', requestedExecution: 'auto', selectableExecution: 'auto',
        });
    });
    it('prefers the daemon for auto on web when the real feature graph admits it', async () => {
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto' })).resolves.toBe('daemon');
    });
    it('keeps explicit web device authority despite unavailable daemon readiness', async () => {
        storage.getState().applySettingsLocal({ featureToggles: { 'voice.daemonInference': false } });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'device' })).resolves.toBe('device');
    });
    it('refuses explicit daemon execution when local policy disables it', async () => {
        storage.getState().applySettingsLocal({ featureToggles: { 'voice.daemonInference': false } });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).rejects.toMatchObject({
            code: 'feature_disabled', message: 'daemon_voice_inference_feature_disabled',
        });
    });
    it('fails closed on the real network-error feature snapshot', async () => {
        primeServerFeaturesSnapshot({ serverId: getActiveServerSnapshot().serverId,
            snapshot: { status: 'error', reason: 'network' } });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'daemon' })).rejects.toMatchObject({ code: 'feature_disabled' });
    });
    it('keeps explicit device execution on native', async () => {
        Platform.OS = 'ios';
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'device' })).resolves.toBe('device');
    });
    it('keeps native auto on-device despite unavailable daemon readiness', async () => {
        Platform.OS = 'ios';
        storage.getState().applySettingsLocal({ featureToggles: { 'voice.daemonInference': false } });
        await expect(resolveDaemonVoiceInferenceExecution({ requestedExecution: 'auto' })).resolves.toBe('device');
    });
});
