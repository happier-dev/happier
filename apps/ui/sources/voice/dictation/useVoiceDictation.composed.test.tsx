import { act } from 'react-test-renderer';
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/auth/context/AuthContext';
import {
    createMachineFixture,
    createRootLayoutFeaturesResponse,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { useVoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

import { resolveVoiceDictationReadiness } from './voiceDictationReadiness';

const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn());

function AuthenticatedHookBoundary({ children }: PropsWithChildren) {
    return (
        <AuthProvider initialCredentials={{ token: 'token-1', secret: 'secret-1' }}>
            {children}
        </AuthProvider>
    );
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
        },
    });
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeSpy(...args),
}));

const initialStorageState = storage.getState();

describe('useVoiceDictation composed daemon readiness', () => {
    afterEach(async () => {
        const { voiceDictationController } = await import('./useVoiceDictation');
        await voiceDictationController.cancel();
        standardCleanup();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        storage.setState(initialStorageState, true);
        vi.doUnmock('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.restoreAllMocks();
        machineRpcWithServerScopeSpy.mockReset();
    });

    it('does not report Ready when the real controller will fail the daemon feature gate before RPC', async () => {
        const executionMachineId = 'machine-ready-at-start';
        const recording = new Blob(['recorded-audio'], { type: 'audio/webm;codecs=opus' });
        setRuntimeFetch(async (input) => {
            if (String(input) !== 'blob:dictation-composed-recording') {
                throw new Error(`unexpected fetch: ${String(input)}`);
            }
            return {
                blob: async () => recording,
            } as Response;
        });
        storage.setState({
            ...storage.getState(),
            machines: {
                [executionMachineId]: createMachineFixture({
                    id: executionMachineId,
                    active: true,
                }),
            },
            settings: {
                ...storage.getState().settings,
                experiments: true,
                featureToggles: {
                    ...storage.getState().settings.featureToggles,
                    voice: true,
                    'execution.runs': false,
                    'voice.agent': true,
                    'voice.daemonInference': true,
                },
                voice: {
                    ...voiceSettingsDefaults,
                    executionMachine: {
                        mode: 'fixed',
                        machineId: executionMachineId,
                        autoMachineId: null,
                    },
                    dictation: {
                        ...voiceSettingsDefaults.dictation,
                        sttBinding: 'explicit',
                        stt: {
                            ...voiceSettingsDefaults.dictation.stt,
                            provider: 'local_neural',
                            localNeural: {
                                ...voiceSettingsDefaults.dictation.stt.localNeural,
                                assetId: 'sherpa-streaming-zipformer-en-20m-2023-02-17',
                                execution: 'daemon',
                            },
                        },
                    },
                },
            },
        });
        primeServerFeaturesSnapshot({
            snapshot: {
                status: 'ready',
                features: createRootLayoutFeaturesResponse({
                    features: {
                        voice: {
                            enabled: true,
                            happierVoice: { enabled: false },
                        },
                    },
                }),
            },
        });

        const executionMachine = await import('@/voice/settings/executionMachine');
        const readinessMachineId = executionMachine.resolveVoiceExecutionMachineIdFromState(
            storage.getState(),
        );
        const startMachineIds: Array<string | null> = [];
        const originalResolveExecutionMachineId = executionMachine.resolveVoiceExecutionMachineId;
        vi.spyOn(executionMachine, 'resolveVoiceExecutionMachineId').mockImplementation((override) => {
            const resolved = originalResolveExecutionMachineId(override);
            startMachineIds.push(resolved);
            return resolved;
        });
        const captureOwnerModule = await import('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.doMock('@/voice/runtime/input/LocalVoiceCaptureOwner', () => ({
            ...captureOwnerModule,
            createLocalVoiceCaptureOwner: (
                deps: Parameters<typeof captureOwnerModule.createLocalVoiceCaptureOwner>[0],
            ) => captureOwnerModule.createLocalVoiceCaptureOwner(deps, {
                // The real capture owner remains active; only its browser
                // recorder system boundary is injected for this composition.
                createRecordingMicSession: () => {
                    let muted = false;
                    return {
                        ensureActive: async () => {},
                        setMuted: (nextMuted: boolean) => {
                            muted = nextMuted;
                        },
                        isMuted: () => muted,
                        teardown: async () => {},
                        getStream: () => null,
                        beginRecording: async () => {},
                        stopRecording: async () => 'blob:dictation-composed-recording',
                    };
                },
            }),
        }));

        const availabilityHook = await renderHook(() => useVoiceProviderLocalAvailability({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        }), { wrapper: AuthenticatedHookBoundary });
        const readiness = resolveVoiceDictationReadiness({
            registry: createDefaultVoiceProviderRegistry(),
            settings: storage.getState().settings,
            platform: 'web',
            executionMachineId: readinessMachineId,
            localAvailability: availabilityHook.getCurrent(),
        });
        const { useVoiceDictation } = await import('./useVoiceDictation');
        const hook = await renderHook(
            () => useVoiceDictation('session-1'),
            { wrapper: AuthenticatedHookBoundary },
        );

        await act(async () => {
            await expect(hook.getCurrent().toggle()).resolves.toEqual({ kind: 'started' });
        });
        await act(async () => {
            await expect(hook.getCurrent().toggle()).rejects.toMatchObject({
                code: 'feature_disabled',
            });
        });

        expect(readinessMachineId).toBe(executionMachineId);
        expect(startMachineIds).toEqual([executionMachineId]);
        expect(machineRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(readiness).toMatchObject({
            status: 'unavailable',
            code: 'server_feature_disabled',
        });
    });
});
