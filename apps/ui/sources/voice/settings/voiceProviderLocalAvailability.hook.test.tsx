import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { AuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    createMachineFixture,
    createRootLayoutFeaturesResponse,
    flushHookEffects,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storageStore';
import { notifyAuthCredentialsInvalidated } from '@/sync/runtime/orchestration/authCredentialsInvalidation';

import { useVoiceProviderLocalAvailability } from './voiceProviderLocalAvailability';

const pcmCaptureAvailabilityMock = vi.hoisted(() => vi.fn(() => 'available'));
const isRecognitionAvailableMock = vi.hoisted(() => vi.fn(() => true));
const requestSpeechPermissionsMock = vi.hoisted(() => vi.fn());
const switchConnectionToActiveServerMock = vi.hoisted(() => (
    vi.fn<() => Promise<AuthCredentials | null>>(async () => null)
));
const syncSwitchServerMock = vi.hoisted(() => vi.fn(async () => {}));
const activeServerState = vi.hoisted(() => {
    const snapshot = {
        serverId: 'server-a',
        serverUrl: 'https://server-a.example.test',
        generation: 1,
    };
    const listeners = new Set<(next: typeof snapshot) => void>();
    return { snapshot, listeners };
});

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

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: switchConnectionToActiveServerMock,
}));

vi.mock('@/sync/sync', () => ({
    syncSwitchServer: syncSwitchServerMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.snapshot,
    subscribeActiveServer: (listener: (next: typeof activeServerState.snapshot) => void) => {
        activeServerState.listeners.add(listener);
        return () => activeServerState.listeners.delete(listener);
    },
}));

vi.mock('@/sync/runtime/orchestration/concurrentSessionCache', () => ({
    startConcurrentSessionCacheSync: vi.fn(),
    stopConcurrentSessionCacheSync: vi.fn(),
}));

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

type AvailabilityHookInput = Parameters<typeof useVoiceProviderLocalAvailability>[0];

function createReadyFeatures() {
    const base = createRootLayoutFeaturesResponse();
    return createRootLayoutFeaturesResponse({
        features: {
            voice: {
                enabled: true,
                happierVoice: { enabled: false },
            },
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: true },
                },
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
    });
}

function createRelayDisabledFeatures(
    base: ReturnType<typeof createRootLayoutFeaturesResponse>,
) {
    return createRootLayoutFeaturesResponse({
        ...base,
        features: {
            ...base.features,
            machines: {
                ...base.features.machines,
                liveStream: {
                    ...base.features.machines.liveStream,
                    serverRouted: { enabled: false },
                },
            },
        },
        capabilities: {
            ...base.capabilities,
            machines: {
                ...base.capabilities.machines,
                liveStream: {
                    serverRouted: {
                        caps: null,
                        disabledReason: 'server_routed_live_stream_disabled',
                    },
                },
            },
        },
    });
}

function createDirectMachine() {
    return createMachineFixture({
        id: 'machine-1',
        daemonState: {
            peerMediation: {
                loopback: {
                    endpoint: {
                        v: 1,
                        routeKind: 'loopback_direct',
                        url: 'http://127.0.0.1:39001/peer-mediation/v1/probe',
                        endpointFingerprint: 'fingerprint-1',
                        expiresAt: Date.now() + 60_000,
                    },
                },
            },
        },
    });
}

describe('useVoiceProviderLocalAvailability', () => {
    let previousStorageState: ReturnType<typeof storage.getState>;
    let readyFeatures: ReturnType<typeof createRootLayoutFeaturesResponse>;

    beforeEach(() => {
        previousStorageState = storage.getState();
        switchConnectionToActiveServerMock.mockReset();
        switchConnectionToActiveServerMock.mockResolvedValue(null);
        syncSwitchServerMock.mockReset();
        readyFeatures = createReadyFeatures();
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: 'server-a',
            snapshot: { status: 'ready', features: readyFeatures },
        });
    });

    afterEach(() => {
        standardCleanup();
        storage.setState(previousStorageState);
        resetServerFeaturesClientForTests();
        activeServerState.listeners.clear();
    });

    async function renderAvailabilityHook(input: AvailabilityHookInput = {}) {
        const Wrapper = ({ children }: React.PropsWithChildren) => (
            <AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
                {children}
            </AuthProvider>
        );
        return await renderHook(
            () => useVoiceProviderLocalAvailability(input),
            { wrapper: Wrapper },
        );
    }

    function installMachine(machine: ReturnType<typeof createMachineFixture>) {
        storage.setState((state) => ({
            ...state,
            machines: { ...state.machines, [machine.id]: machine },
            machineListByServerId: {
                ...state.machineListByServerId,
                'server-a': [machine],
            },
        }));
    }

    it('loads native recognition support passively without requesting microphone permission', async () => {
        isRecognitionAvailableMock.mockReturnValueOnce(false);
        const hook = await renderAvailabilityHook();

        expect(hook.getCurrent().nativeDevice).toEqual({
            requested: true,
            speechRecognition: 'unavailable',
        });
        expect(isRecognitionAvailableMock).toHaveBeenCalledTimes(1);
        expect(requestSpeechPermissionsMock).not.toHaveBeenCalled();
    });

    it('passes native daemon PCM capture availability into the provider resolver', async () => {
        const hook = await renderAvailabilityHook({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });

        const localAvailability = hook.getCurrent();

        expect(pcmCaptureAvailabilityMock).toHaveBeenCalled();
        expect(localAvailability.daemon).toMatchObject({
            route: 'relay',
            modelState: 'ready',
            runtimeState: 'available',
            pcmCapture: 'available',
        });
    });

    it('recomputes the passive direct route when same-machine endpoint and server policy facts are lost and restored', async () => {
        const relayDisabledFeatures = createRelayDisabledFeatures(readyFeatures);
        primeServerFeaturesSnapshot({
            serverId: 'server-a',
            snapshot: { status: 'ready', features: relayDisabledFeatures },
        });
        const machine = createDirectMachine();
        installMachine(machine);
        const hook = await renderAvailabilityHook({
            daemonMachineId: machine.id,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });

        expect(hook.getCurrent().daemon?.route).toBe('direct');

        await act(async () => {
            installMachine(createMachineFixture({
                ...machine,
                daemonState: { peerMediation: { loopback: {} } },
            }));
        });
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        await act(async () => {
            installMachine(machine);
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');

        const rpcDisabled = createRootLayoutFeaturesResponse({
            ...relayDisabledFeatures,
            features: {
                ...relayDisabledFeatures.features,
                machines: {
                    ...relayDisabledFeatures.features.machines,
                    rpc: {
                        enabled: true,
                        directPeer: { enabled: false },
                    },
                },
            },
        });
        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: 'server-a',
                snapshot: { status: 'ready', features: rpcDisabled },
            });
        });
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        await act(async () => {
            primeServerFeaturesSnapshot({
                serverId: 'server-a',
                snapshot: { status: 'ready', features: relayDisabledFeatures },
            });
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');
    });

    it('recomputes passive direct readiness when mounted AuthContext credentials are lost and restored', async () => {
        const relayDisabledFeatures = createRelayDisabledFeatures(readyFeatures);
        primeServerFeaturesSnapshot({
            serverId: 'server-a',
            snapshot: { status: 'ready', features: relayDisabledFeatures },
        });
        const machine = createDirectMachine();
        installMachine(machine);
        const hook = await renderAvailabilityHook({
            daemonMachineId: machine.id,
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');

        switchConnectionToActiveServerMock.mockResolvedValueOnce(null);
        await act(async () => {
            notifyAuthCredentialsInvalidated({
                kind: 'credentials_removed',
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            });
            await flushHookEffects({ cycles: 4, turns: 2 });
        });
        expect(hook.getCurrent().daemon?.route).toBe('relay_disabled');

        switchConnectionToActiveServerMock.mockResolvedValueOnce({
            token: 'token-2',
            secret: 'secret-2',
        });
        await act(async () => {
            notifyAuthCredentialsInvalidated({
                kind: 'credentials_removed',
                serverId: 'server-a',
                serverUrl: 'https://server-a.example.test',
            });
            await flushHookEffects({ cycles: 4, turns: 2 });
        });
        expect(hook.getCurrent().daemon?.route).toBe('direct');
    });
});
