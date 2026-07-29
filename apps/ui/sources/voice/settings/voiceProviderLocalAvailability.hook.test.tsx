import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const pcmCaptureAvailabilityMock = vi.hoisted(() => vi.fn(() => 'available'));
const isRecognitionAvailableMock = vi.hoisted(() => vi.fn(() => true));
const requestSpeechPermissionsMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'ios',
            select: (options: Record<string, unknown>) =>
                options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
        },
    });
});

vi.mock('@/hooks/server/useFeatureLocalPolicySettings', () => ({
    useFeatureLocalPolicySettings: () => ({}),
}));

vi.mock('@/sync/domains/features/featureLocalPolicy', () => ({
    resolveLocalFeaturePolicyEnabled: () => true,
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', async () => {
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit');
    const base = createRootLayoutFeaturesResponse();
    return {
        getCachedReadyServerFeatures: () => createRootLayoutFeaturesResponse({
            features: {
                machines: {
                    enabled: true,
                    liveStream: {
                        enabled: true,
                        directPeer: { enabled: false },
                        serverRouted: { enabled: true },
                    },
                },
            },
            capabilities: {
                machines: {
                    ...base.capabilities.machines,
                    liveStream: {
                        serverRouted: {
                            caps: {
                                maxBitrateBps: 96_000,
                                maxFramesPerSecond: 50,
                                maxFrameBytes: 16_384,
                                maxDurationMs: 60_000,
                                maxTotalBytes: 4_000_000,
                                maxConcurrentStreamsPerAccount: 2,
                                maxConcurrentStreamsPerSocket: 1,
                                maxConcurrentStreamsPerMachine: 1,
                            },
                            disabledReason: null,
                        },
                    },
                },
            },
        }),
    };
});

vi.mock('@/voice/settings/browserWebSpeechCapability', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/voice/settings/browserWebSpeechCapability')>();
    return {
        ...actual,
        useBrowserWebSpeechCapability: () => ({ support: 'unavailable', onDevice: 'unsupported' }),
    };
});

vi.mock('@/voice/runtime/daemonInference/resolveDaemonSpeechPcmCaptureAvailability', () => ({
    resolveDaemonSpeechPcmCaptureAvailability: () => pcmCaptureAvailabilityMock(),
}));

vi.mock('expo-speech-recognition', () => ({
    ExpoSpeechRecognitionModule: {
        isRecognitionAvailable: isRecognitionAvailableMock,
        requestPermissionsAsync: requestSpeechPermissionsMock,
    },
}));

describe('useVoiceProviderLocalAvailability', () => {
    it('loads native recognition support passively without requesting microphone permission', async () => {
        isRecognitionAvailableMock.mockReturnValueOnce(false);
        const { useVoiceProviderLocalAvailability } = await import('./voiceProviderLocalAvailability');

        const hook = await renderHook(() => useVoiceProviderLocalAvailability());

        expect(hook.getCurrent().nativeDevice).toEqual({
            requested: true,
            speechRecognition: 'unavailable',
        });
        expect(isRecognitionAvailableMock).toHaveBeenCalledTimes(1);
        expect(requestSpeechPermissionsMock).not.toHaveBeenCalled();
    });

    it('passes native daemon PCM capture availability into the provider resolver', async () => {
        const { useVoiceProviderLocalAvailability } = await import('./voiceProviderLocalAvailability');
        const { resolveVoiceProviderAvailability } = await import('./resolveVoiceProviderAvailability');

        const hook = await renderHook(() => useVoiceProviderLocalAvailability({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        }));

        const localAvailability = hook.getCurrent();
        const availability = resolveVoiceProviderAvailability({
            happierVoiceSupported: true,
            platformOs: 'ios',
            local: localAvailability,
        });

        expect(pcmCaptureAvailabilityMock).toHaveBeenCalled();
        expect(localAvailability.daemon).toMatchObject({
            route: 'relay',
            modelState: 'ready',
            runtimeState: 'available',
            pcmCapture: 'available',
        });
        expect(availability.local.paths.daemon).toMatchObject({
            selectable: true,
            runnable: true,
            readiness: 'ready',
            reason: null,
        });
    });
});
