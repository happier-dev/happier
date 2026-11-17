import { act } from 'react-test-renderer';
import * as React from 'react';
import type { PropsWithChildren } from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';

import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    createMachineFixture,
    createRootLayoutFeaturesResponse,
    renderHook,
    renderScreen,
    waitForTestEvent,
    standardCleanup,
} from '@/dev/testkit';
import {
    primeServerFeaturesSnapshot,
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import * as runtimeFetchAdapter from '@/utils/system/runtimeFetch';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { useVoiceProviderLocalAvailability } from '@/voice/settings/voiceProviderLocalAvailability';

import { resolveVoiceDictationReadiness } from './voiceDictationReadiness';

const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn());
const stopRecording = vi.hoisted(() => vi.fn(async () => 'blob:dictation-composed-recording'));
const recognition = vi.hoisted(() => ({ listeners: new Map<string, (event: unknown) => void>() }));
let account: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
let credentials: Awaited<ReturnType<typeof TokenStorage.getCredentialsForServerUrl>>;
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    addListener: (name: string, listener: (event: unknown) => void) => {
        recognition.listeners.set(name, listener);
        return { remove: () => recognition.listeners.delete(name) };
    },
    start: () => recognition.listeners.get('audiostart')?.({}),
    stop: () => {
        recognition.listeners.get('result')?.({ isFinal: true, results: [{ transcript: 'SUMMARIZE THIS PROJECT' }] });
        recognition.listeners.get('end')?.({});
    },
} }));

// Expo is the SDK leaf. NativeMicSession, audio-mode custody and capture stay real.
vi.mock('expo-audio', () => {
    class AudioRecorderWeb {
        uri: string | null = null;
        async prepareToRecordAsync() {}
        pause() {}
        record() {}
        async stop() { this.uri = await stopRecording(); }
    }
    return { AudioModule: { AudioRecorderWeb, setAudioModeAsync: async () => {} },
        RecordingPresets: { HIGH_QUALITY: { web: { mimeType: 'audio/webm' } } } };
});

function AuthenticatedHookBoundary({ children }: PropsWithChildren) {
    return (
        <InjectedAuthProvider credentials={credentials!}>
            {children}
        </InjectedAuthProvider>
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

installSessionActionRpcBoundary(request => machineRpcWithServerScopeSpy(request));
const recordingModule = await loadVitestModuleForNodeRequire(
    new URL('../runtime/mic/NativeMicSession.ts', import.meta.url),
    () => import('@/voice/runtime/mic/NativeMicSession'),
);
afterAll(() => recordingModule.dispose());

const initialStorageState = storage.getState();

describe('useVoiceDictation composed daemon readiness', () => {
    afterEach(async () => {
        const { voiceDictationController } = await import('./useVoiceDictation');
        await voiceDictationController.cancel();
        standardCleanup();
        resetRuntimeFetch();
        resetServerFeaturesClientForTests();
        storage.setState(initialStorageState, true);
        vi.restoreAllMocks();
        machineRpcWithServerScopeSpy.mockReset();
        await account?.dispose();
        vi.unstubAllGlobals();
    });

    it('shows a real recognizer partial in its composer leaf without committing the draft', async () => {
        const deviceModule = await loadVitestModuleForNodeRequire(
            new URL('../input/DeviceSttController.ts', import.meta.url),
            () => import('@/voice/input/DeviceSttController'),
        );
        try {
            account = await createPlainArtifactHomeFixture('https://dictation-preview.test');
            credentials = await TokenStorage.getCredentialsForServerUrl('https://dictation-preview.test');
            vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
            storage.setState({ settings: { ...storage.getState().settings, voice: {
                ...voiceSettingsDefaults, dictation: { ...voiceSettingsDefaults.dictation,
                    sttBinding: 'explicit', stt: { ...voiceSettingsDefaults.dictation.stt, provider: 'device' } },
            } } });
            const { voiceDictationController } = await import('./useVoiceDictation');
            const { SessionAuthoringComposer } = await import('@/components/sessions/authoring/SessionAuthoringComposer');
            const { composerRefV1Key } = await import('@happier-dev/protocol/plugins/ui/composerRef');
            const composerRef = { kind: 'newSession', instanceId: 'dictation-preview' } as const;
            const changed = vi.fn();
            const screen = await renderScreen(React.createElement(SessionAuthoringComposer, {
                composerRef, value: 'Existing draft', onChangeText: changed,
            }));
            await act(async () => { await voiceDictationController.toggle({ controlId: composerRefV1Key(composerRef), transcriptionSessionId: null }); });
            await act(async () => {
                recognition.listeners.get('result')?.({ isFinal: false, results: [{ transcript: 'SUMMARIZE' }] });
            });
            expect(screen.findHostByTestId('voice-dictation-partial')?.props.children).toBe('Summarize');
            expect(changed).not.toHaveBeenCalled();
            await act(async () => { await voiceDictationController.cancel(); });
            expect(screen.findHostByTestId('voice-dictation-partial')).toBeNull();
            expect(changed).not.toHaveBeenCalled();
        } finally {
            deviceModule.dispose();
        }
    });

    it('does not report Ready when local feature policy blocks daemon Dictation before RPC', async () => {
        const executionMachineId = 'machine-ready-at-start';
        const installedFetch = vi.spyOn(runtimeFetchAdapter, 'setRuntimeFetch');
        let respondHome: Parameters<typeof setRuntimeFetch>[0] | null = null;
        try {
            account = await createPlainArtifactHomeFixture('https://dictation-readiness.test');
            respondHome = installedFetch.mock.calls.at(-1)?.[0] ?? null;
        } finally {
            installedFetch.mockRestore();
        }
        if (!respondHome) throw new Error('Expected the canonical Home HTTP boundary');
        const homeHttpBoundary = respondHome;
        const recording = new Blob(['recorded-audio'], { type: 'audio/webm;codecs=opus' });
        setRuntimeFetch(async (input, init) => String(input) === 'blob:dictation-composed-recording'
            ? new Response(recording)
            : await homeHttpBoundary(input, init));
        credentials = await TokenStorage.getCredentialsForServerUrl('https://dictation-readiness.test');
        stopRecording.mockClear();
        vi.stubGlobal('navigator', {
            mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
        });
        storage.setState({
            ...storage.getState(),
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
        await publishMachineInventoryForTest({ serverId: account.home.id, accountId: 'artifact-account' }, [
            createMachineFixture({ id: executionMachineId, active: true, activeAt: Date.now() }),
        ]);
        primeServerFeaturesSnapshot({
            serverId: account.home.id,
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
        const availabilityHook = await renderHook(() => useVoiceProviderLocalAvailability({
            daemonModelState: 'ready',
            daemonRuntimeState: 'available',
        }), { wrapper: AuthenticatedHookBoundary });
        const readiness = resolveVoiceDictationReadiness({
            registry: createDefaultVoiceProviderRegistry(),
            settings: storage.getState().settings,
            connectedPurposes: null,
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
            await expect(hook.getCurrent().toggle()).resolves.toEqual({ kind: 'cancelled' });
        });
        expect(hook.getCurrent().failure).toMatchObject({
            kind: 'provider_error',
            reason: 'provider_unavailable',
        });

        expect(readinessMachineId).toBe(executionMachineId);
        expect(startMachineIds).toEqual([executionMachineId]);
        expect(machineRpcWithServerScopeSpy).not.toHaveBeenCalled();
        expect(readiness).toMatchObject({
            status: 'needs_setup',
            code: 'feature_policy_disabled',
        });

        storage.setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    dictation: {
                        ...storage.getState().settings.voice.dictation,
                        sttBinding: 'explicit',
                        stt: {
                            ...storage.getState().settings.voice.dictation.stt,
                            provider: 'happier.voice.openai-compat/stt',
                        },
                    },
                },
            },
        });
        await act(async () => {
            // The failed recording belongs to Retry/Discard until explicitly
            // released; selecting another provider does not abandon it.
            await hook.getCurrent().discard();
            await expect(hook.getCurrent().toggle()).resolves.toEqual({ kind: 'started' });
        });
        expect(stopRecording).toHaveBeenCalledOnce();

        await act(async () => {
            primeServerFeaturesSnapshot({
                snapshot: {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            voice: {
                                enabled: false,
                                happierVoice: { enabled: false },
                            },
                        },
                    }),
                },
            });
        });

        await waitForTestEvent(hook.subscribe, hook.getCurrent, current => current.status === 'idle');
        expect(hook.getCurrent().status).toBe('idle');
        expect(stopRecording).toHaveBeenCalledTimes(2);
        await expect(hook.getCurrent().toggle()).resolves.toEqual({ kind: 'cancelled' });

    });
});
