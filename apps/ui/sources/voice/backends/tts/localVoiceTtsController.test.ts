import { VoiceProviderContributionSchema } from '@happier-dev/protocol/plugins/contributions/voice';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { DaemonVoiceInferenceTtsStreamStartResponseSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { DaemonVoiceInferenceModelStatusSchema } from '@happier-dev/protocol/daemon/voiceInference';
import { getDefaultModelPackId, getModelPackCatalogEntry } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { createExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import {
    commitExternalVoiceProviderRegistration,
    removeExternalVoiceProviderRegistration,
} from '@/voice/registry/externalVoiceProviderRegistrations';
import type { VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());

let account: Awaited<ReturnType<typeof serveAccountHomes>>;
let disconnect: (() => Promise<void>) | undefined;
const speechBoundary = createVoiceSpeechOutputBoundary({ getAccount: async () => {
    const home = account.homes.voice!;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
    if (!credentials) throw new Error('TTS Account credentials unavailable');
    return { home, credentials };
} });
const { encodedAudio, machineRpc, expoSpeechSpeak, nativeSynthesize, daemonStreamStartRpc,
    speechSynthesizeRpc } = speechBoundary;
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { sync } = await import('@/sync/sync');
const { createLocalVoiceTtsController } = await import('./localVoiceTtsController');
const { createDefaultLocalVoiceTtsProviderControllers } = await import('./localVoiceTtsProviderControllers');
const { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
const initialSettings = storage.getState().settings;
const initialMachines = storage.getState().machines;
const initialMachineLists = storage.getState().machineListByServerId;
const serverFeatures = FeaturesResponseSchema.parse({ features: {
    voice: { enabled: true }, execution: { runs: { enabled: true } },
    machines: { enabled: true, liveStream: { enabled: true, serverRouted: { enabled: true } } },
}, capabilities: { machines: { liveStream: { serverRouted: { disabledReason: null, caps: {
    maxBitrateBps: 64_000, maxFramesPerSecond: 50, maxFrameBytes: 16_000,
    maxDurationMs: 60_000, maxTotalBytes: 1_000_000, maxConcurrentStreamsPerAccount: 2,
    maxConcurrentStreamsPerSocket: 1, maxConcurrentStreamsPerMachine: 1,
} } } } } });

afterAll(() => speechBoundary.disposeAudioSession());

describe('localVoiceTtsController', () => {
    let featureResponse: () => Response;
    async function restoreAccount(state: 'enabled' | 'disabled' | 'unavailable' = 'enabled') {
        // The Account has no persisted Sessions; later local projections are not its HTTP census.
        const sessionHttp = createSessionMetadataHttpBoundary(() => ({}));
        featureResponse = state === 'unavailable'
            ? () => { throw new TypeError('Feature service network failure'); }
            : () => Response.json(state === 'disabled'
                ? FeaturesResponseSchema.parse({ ...serverFeatures,
                    features: { ...serverFeatures.features, voice: { ...serverFeatures.features.voice, enabled: false } } })
                : serverFeatures);
        account = await serveAccountHomes({ homes: [{ key: 'voice',
            serverUrl: `https://tts-controller-${state}.test`, accountId: 'tts-account' }],
            route: async request => {
                const sessionReply = sessionHttp.handle(request.url);
                if (sessionReply) return sessionReply;
                const machineReply = speechBoundary.answerMachineHttpRequest(request.url, 'tts-machine', 'tts-account', request);
                if (machineReply) return machineReply;
                if (request.path === '/v1/features') return featureResponse();
                if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                return createEmptyAccountBootstrapHttpResponse(request.path, {
                    method: request.method, headers: request.headers,
                }) ?? undefined;
            } });
        disconnect = await account.restoreActiveConnection();
        await sync.resumeSync('manual');
        // Preserve Sync's admitted plain-content context instead of replacing its hydrated Machine.
        await vi.waitFor(() => expect(storage.getState().machines['tts-machine']?.access?.resourceMode).toBe('plain'));
        const machine = storage.getState().machines['tts-machine']!;
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ experiments: true, featureToggles: {
            voice: true, 'execution.runs': true, 'voice.agent': true, 'voice.daemonInference': true,
        }, voice: { ...storage.getState().settings.voice,
            executionMachine: { mode: 'fixed', machineId: machine.id, autoMachineId: null } } }, storage.getState().settings));
    }

    async function retireAccount() {
        await disconnect?.();
        disconnect = undefined;
        await account?.dispose();
        resetServerFeaturesClientForTests();
    }

    beforeEach(async () => {
        speechBoundary.reset();
        await restoreAccount();
    });

    afterEach(async () => {
        await retireAccount();
        speechBoundary.disposeNativeSdkBridge();
        storage.setState({ settings: initialSettings, machines: initialMachines, machineListByServerId: initialMachineLists });
    });

    it('drives opt-in waiting audio from real lifecycle pushes and retires it on phase or preference change', async () => {
        const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
        const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
        const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const previousAdapters = getVoiceAdapterRegistry().list();
        const settings = storage.getState().settings;
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
            voice: { ...settings.voice, providerId: 'local_direct', audibleWaitingCue: true },
        }, settings));
        expect(storage.getState().settings.voice.audibleWaitingCue).toBe(true);
        registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
        const lifecycle = (await import('@/voice/session/voiceSessionLifecycleController')).createVoiceSessionLifecycleController();
        lifecycle.setConfiguredProviderId('local_direct');
        try {
            machine.transitionToListening({ controlSessionId: 'cue' });
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
            expect(encodedAudio.start).not.toHaveBeenCalled();
            const firstCue = speechBoundary.holdNextPlayback('encoded');
            machine.transitionToThinking({ controlSessionId: 'cue' });
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: 'thinking' });
            await vi.waitFor(() => expect(encodedAudio.start).toHaveBeenCalledTimes(1));
            await firstCue.started;
            for (let i = 0; i < 20; i++) machine.transitionToThinking({ controlSessionId: 'cue' });
            expect(encodedAudio.start).toHaveBeenCalledTimes(1);
            machine.transitionToSpeaking({ controlSessionId: 'cue' });
            await vi.waitFor(() => expect(encodedAudio.stop).toHaveBeenCalledTimes(1));
            const secondCue = speechBoundary.holdNextPlayback('encoded');
            machine.transitionToThinking({ controlSessionId: 'cue' });
            await vi.waitFor(() => expect(encodedAudio.start).toHaveBeenCalledTimes(2));
            await secondCue.started;
            const current = storage.getState().settings;
            storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
                voice: { ...current.voice, audibleWaitingCue: false },
            }, current));
            await vi.waitFor(() => expect(encodedAudio.stop).toHaveBeenCalledTimes(2));
            machine.transitionToListening({ controlSessionId: 'cue' });
            machine.transitionToThinking({ controlSessionId: 'cue' });
            expect(encodedAudio.start).toHaveBeenCalledTimes(2);
        } finally {
            machine.reset();
            await lifecycle.dispose();
            registerVoiceAdapters(previousAdapters);
        }
    });

    it.each([
        ['device', 'local_conversation'],
        ['local_neural', 'local_conversation'],
        ['local_neural', 'happier.voice.xai/realtime-grok'],
    ] as const)('reads an assistant message through the %s say Action with %s conversation, stops from presence and replays', async (provider, conversationProvider) => {
        const { localVoiceTtsController } = await import('./localVoiceTtsController');
        const playback = speechBoundary.holdNextPlayback(provider === 'device' ? 'device' : 'encoded');
        const voice = storage.getState().settings.voice;
        const local = readLocalConversationVoiceSettings(voice);
        storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: writeLocalConversationVoiceSettings({
            ...voice, providerId: conversationProvider,
        }, { ...local, tts: { ...local.tts, provider,
            localNeural: { ...local.tts.localNeural, model: 'kokoro', execution: 'daemon' },
        } }) }, storage.getState().settings));
        expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).tts.provider).toBe(provider);
        expect(storage.getState().settings.voice.providerId).toBe(conversationProvider);
        // The Action captures its Account's settings from HTTP, just as setup does.
        account.replaceAccountSettings('voice', { settings: storage.getState().settings, version: 1 });
        const React = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen, createTestSessionTranscriptSource, wrapWithSessionTranscriptSource } = await import('@/dev/testkit');
        const { CommittedMessageActions } = await import('@/components/sessions/transcript/messageActions/CommittedMessageActions');
        const { IconButton } = await import('@/components/ui/buttons/IconButton');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(account.homes.voice!.serverUrl);
        const { VoiceTopBarPresence } = await import('@/components/voice/presence/VoiceTopBarPresence');
        const { useVoiceReadAloud } = await import('@/components/voice/presence/VoiceReadAloud');
        const { buildVoicePresenceFixture } = await import('@/components/dev/voicePresence/voicePresenceFixtures');
        const { t } = await import('@/text');
        const { translateVoiceReadiness } = await import('@/voice/settings/panels/voiceProviderReadinessPresentation');
        let catalog: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let refreshCatalog: (() => void) | undefined;
        let runtimeSupported = true;
        if (provider === 'local_neural') {
            const packId = getDefaultModelPackId('tts_sherpa')!;
            const entry = getModelPackCatalogEntry(packId)!;
            const answerSpeechRpc = machineRpc.getMockImplementation()!;
            machineRpc.mockImplementation(async request => {
                if (request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST
                    || request.method === RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS) {
                    return { ok: true, models: [DaemonVoiceInferenceModelStatusSchema.parse({
                        packId, pluginIdentity: null, kind: entry.kind, model: entry.model, version: null,
                        executionSupport: ['daemon'], runtimeFamily: entry.runtimeFamily, runtimeSupported,
                        installState: 'installed', runtimeState: 'ready', progress: null, lastError: null, updatedAtMs: 1,
                    })] };
                }
                return answerSpeechRpc(request);
            });
            const { VoiceSpeechModelCatalogRuntime } = await import('@/voice/session/VoiceSpeechModelCatalogRuntime');
            const { captureDaemonVoiceModelCatalogObservation } = await import('@/voice/settings/panels/modelCatalog/daemonVoiceModelCatalogObservation');
            refreshCatalog = () => captureDaemonVoiceModelCatalogObservation('tts-machine').invalidate();
            // Mount the real app producer, without opening setup or preloading its catalog.
            catalog = await renderScreen(React.createElement(InjectedAuthProvider, {
                credentials, children: React.createElement(VoiceSpeechModelCatalogRuntime),
            }));
        }
        const retained = buildVoicePresenceFixture('ended');
        const dismiss = vi.fn();
        function Presence() {
            return React.createElement(VoiceTopBarPresence, {
                voice: { ...retained, onDismissEnded: dismiss }, readAloud: useVoiceReadAloud(),
            });
        }
        const presence = await renderScreen(React.createElement(Presence));
        // Device speech also covers a long message; this daemon boundary returns one protocol-sized segment.
        const text = provider === 'device' ? 'A chosen progress note. '.repeat(200) : 'A chosen progress note.';
        const message = { kind: 'agent-text' as const, id: 'answer', localId: 'answer', text, createdAt: 1, seq: 1, isThinking: false };
        const messageActions = await renderScreen(React.createElement(InjectedAuthProvider, { credentials, children: wrapWithSessionTranscriptSource(React.createElement(CommittedMessageActions, {
            message, sessionId: 's1', serverId: account.homes.voice!.id,
            selectableText: { role: 'assistant', text }, copyText: text, isStructuredOnly: false,
            canFork: false, forkCommon: { sessionReplayEnabled: false, sessionReplayStrategy: 'recent_messages',
                sessionReplayMaxSeedChars: 50_000, sessionReplaySummaryRunnerV1: null,
                executionRunsEnabled: false, agentSwitchingEnabled: false,
                sessionForkSupportSource: { metadata: null } }, isForkAllowed: () => false,
            settings: { ...storage.getState().settings, workspacePath: null, debugInformationEnabled: false },
            showActions: true, showPinAction: false, timestampText: null, invertTimestampAndActions: false,
            onActionsFocus: () => {}, onActionsBlur: () => {}, touchRevealKey: null,
            children: row => row,
        }), createTestSessionTranscriptSource({ sessionId: 's1', serverId: account.homes.voice!.id })) }));
        const readAloudButton = () => messageActions.findAllByType(IconButton)
            .find(button => button.props.testID === 'transcript-message-readAloud:answer');
        // The rendered message control enters the real default executor; only speech/OS and network are substituted.
        try {
            expect(readLocalConversationVoiceSettings(storage.getState().settings.voice).tts.provider).toBe(provider);
            await vi.waitFor(() => expect(readAloudButton()?.props.disabled).toBe(false));
            await act(async () => {
                messageActions.pressByTestId('transcript-message-readAloud:answer');
            });
            await vi.waitFor(() => expect(provider === 'device' ? expoSpeechSpeak : encodedAudio.start).toHaveBeenCalled());
            await playback.started;
            if (provider === 'device') expect(expoSpeechSpeak).toHaveBeenCalledWith(text.trim(), expect.anything());
            else expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({ text: text.trim() }));
            expect(localVoiceTtsController.readSay()).toBe('speaking');
            await vi.waitFor(() => expect(presence.getTextContent()).toContain(t('voicePresence.readAloud.speaking')));
            await presence.pressByTestIdAsync('voice-top-bar-read-aloud-stop');
            if (provider === 'device') expect(speechBoundary.expoSpeechStop).toHaveBeenCalledTimes(1);
            else expect(encodedAudio.stop).toHaveBeenCalledTimes(1);
            expect(localVoiceTtsController.readSay()).toBe('idle');
            await presence.pressByTestIdAsync('voice-top-bar-transport-dismiss');
            expect(dismiss).toHaveBeenCalledTimes(1);
            expoSpeechSpeak.mockImplementation((_text, options) => { options.onStart?.(); options.onDone?.(); });
            await messageActions.pressByTestIdAsync('transcript-message-readAloud:answer');
            if (provider === 'device') expect(expoSpeechSpeak).toHaveBeenLastCalledWith(text.trim(), expect.anything());
            else expect(daemonStreamStartRpc).toHaveBeenLastCalledWith(expect.objectContaining({ text: text.trim() }));
            expect(localVoiceTtsController.readSay()).toBe('idle');
            if (refreshCatalog) {
                runtimeSupported = false;
                await act(async () => { await refreshCatalog?.(); });
                await vi.waitFor(() => expect(readAloudButton()?.props.disabled).toBe(true));
                expect(readAloudButton()?.props.disabledReason)
                    .toContain(translateVoiceReadiness('voice.readiness.runtime_missing'));
                expect(readAloudButton()?.props.onDisabledPress).toEqual(expect.any(Function));
            }
        } finally {
            localVoiceTtsController.stopSay();
            await presence.unmount();
            await messageActions.unmount();
            await catalog?.unmount();
        }
    });

    it('dispatches a current external dual-role speech provider through normal Local Voice TTS', async () => {
        const declaration = VoiceProviderContributionSchema.parse({
            id: 'speech',
            title: 'External speech',
            kind: 'speech',
            roles: ['conversation_stt', 'conversation_tts'],
            platforms: ['web'],
            settings: {
                schemaVersion: 2,
                fields: [
                    {
                        id: 'model',
                        title: 'Model',
                        schema: { type: 'string', minLength: 1, maxLength: 256 },
                        default: 'external-model',
                        presentation: { control: 'text' },
                    },
                    {
                        id: 'voiceName',
                        title: 'Voice',
                        schema: { type: 'string', minLength: 1, maxLength: 256 },
                        default: 'external-voice',
                        presentation: { control: 'text' },
                    },
                    {
                        id: 'format',
                        title: 'Format',
                        schema: { type: 'string', enum: ['mp3', 'wav'] },
                        default: 'wav',
                        presentation: {
                            control: 'select',
                            options: [
                                { value: 'mp3', title: 'MP3' },
                                { value: 'wav', title: 'WAV' },
                            ],
                        },
                    },
                ],
            },
        });
        if (declaration.kind !== 'speech') throw new Error('expected speech declaration');

        const pluginId = 'acme.external';
        const providerId = `${pluginId}/${declaration.id}`;
        const token = {};
        const providerSettings = createExternalVoiceProviderSettingsDescriptor(declaration.settings);
        const descriptor = {
            kind: 'voice.speech-engine.v1',
            pluginId,
            providerId,
            settingsSectionId: providerId,
            roles: declaration.roles,
            requirements: ['execution_machine'],
            supportedPlatforms: declaration.platforms,
            role: 'both',
            declaration,
            catalogs: declaration.catalogs,
            limits: declaration.limits,
            presentation: {
                providerId,
                settingsSectionId: providerId,
                createSettingsSpec: () => ({
                    titleKey: 'External speech',
                    subtitleKey: 'External speech',
                    detailKey: 'External speech',
                    iconName: 'extension',
                    fields: declaration.settings.fields.map((field) => ({
                        fieldId: field.id,
                        titleKey: typeof field.title === 'string' ? field.title : field.id,
                        subtitleKey: typeof field.title === 'string' ? field.title : field.id,
                    })),
                    test: null,
                }),
            },
            providerSettings,
            source: { kind: 'external', pluginId, localId: declaration.id },
        } satisfies VoiceProviderRegistryEntry;
        commitExternalVoiceProviderRegistration({
            token,
            pluginId,
            localId: declaration.id,
            providerId,
            descriptor,
            adapter: null,
        });

        const onSpeaking = vi.fn();
        const controller = createLocalVoiceTtsController();
        const request = {
            sessionId: 'session-external',
            text: 'speak through both roles',
            settings: {
                voice: voiceSettingsParse({
                    providers: {
                        [providerId]: {
                            schemaVersion: 2,
                            config: providerSettings.defaultConfig,
                        },
                    },
                }),
            },
            tts: { ...readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' })).tts,
                provider: providerId },
            networkTimeoutMs: 15_000,
            registerPlaybackStopper: () => () => {},
            onSpeaking,
        } as const;

        try {
            await expect(controller.speak(request)).resolves.toBeUndefined();
            expect(speechSynthesizeRpc).toHaveBeenCalledWith(expect.objectContaining({
                target: { pluginId, localId: declaration.id },
                input: 'speak through both roles',
            }));
            const dispatch = speechSynthesizeRpc.mock.calls[0]?.[0];
            expect(dispatch).not.toHaveProperty('model');
            expect(dispatch).not.toHaveProperty('voiceName');
            expect(dispatch).not.toHaveProperty('format');
            expect(encodedAudio.start).toHaveBeenCalledTimes(1);
            expect(onSpeaking).toHaveBeenCalledTimes(1);

            removeExternalVoiceProviderRegistration(token);
            await expect(controller.speak(request)).rejects.toMatchObject({
                code: 'provider_unavailable',
            });
        } finally {
            removeExternalVoiceProviderRegistration(token);
        }
    });

    it('delegates provider routing through a configured map of real TTS controllers', async () => {
        const defaults = createDefaultLocalVoiceTtsProviderControllers();
        const controller = createLocalVoiceTtsController({ controllers: {
            device: defaults.get('local_neural'),
        } });
        const onSpeaking = vi.fn();
        const request = neuralRequest({ text: 'delegate me', onSpeaking });
        await controller.speak({ ...request, tts: { ...request.tts, provider: 'device' } });
        expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({
            text: 'delegate me', voiceId: 'af_heart',
        }));
        expect(encodedAudio.start).toHaveBeenCalledOnce();
        expect(onSpeaking).toHaveBeenCalledOnce();
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(nativeSynthesize).not.toHaveBeenCalled();
        expect(speechSynthesizeRpc).not.toHaveBeenCalled();
    });

    it('leaves an unset daemon voice null so the selected pack runtime owns its declared default', async () => {
        const onSpeaking = vi.fn();
        await createLocalVoiceTtsController().speak(neuralRequest({
            text: 'use the declared default', packId: 'acme.voice/tts-pack', voiceId: null, onSpeaking,
        }));
        expect(daemonStreamStartRpc).toHaveBeenCalledWith(expect.objectContaining({
            packId: 'acme.voice/tts-pack', voiceId: null,
        }));
        expect(encodedAudio.start).toHaveBeenCalledOnce();
        expect(onSpeaking).toHaveBeenCalledOnce();
    });

    it.each([
        'machine_unreachable', 'runtime_unavailable', 'model_not_installed',
        'request_timeout', 'unsupported_codec', 'download_failed', 'internal_error',
    ] as const)('reports %s from explicit daemon local_neural TTS without changing execution or provider', async code => {
        if (code === 'download_failed') {
            // Download failure belongs to the client transport, not the daemon error union.
            daemonStreamStartRpc.mockRejectedValueOnce(new Error('daemon_voice_inference_download_failed'));
        } else {
            machineRpc.mockImplementationOnce(async request => {
                expect(request.method).toBe('daemon.voiceInference.tts.stream.start');
                await daemonStreamStartRpc(request.payload);
                return DaemonVoiceInferenceTtsStreamStartResponseSchema.parse({ ok: false,
                    errorCode: code, error: `daemon_voice_inference_${code}` });
            });
        }
        const onTtsFailed = vi.fn();
        await createLocalVoiceTtsController().speak(neuralRequest({ onTtsFailed }));
        expect(daemonStreamStartRpc).toHaveBeenCalledOnce();
        expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'tts-machine', method: 'daemon.voiceInference.tts.stream.start',
        }));
        expect(nativeSynthesize).not.toHaveBeenCalled();
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(encodedAudio.start).not.toHaveBeenCalled();
        expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'tts_failed', reason: `daemon_voice_inference_${code}`,
        }));
    });

    it('reports segmented daemon playback failure through the typed TTS recovery owner', async () => {
        encodedAudio.start.mockRejectedValueOnce(new Error('native_playback_failed'));
        const onTtsFailed = vi.fn();
        await createLocalVoiceTtsController().speak(neuralRequest({ onTtsFailed }));
        expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'tts_failed', reason: 'native_playback_failed', recoverable: true,
        }));
        expect(machineRpc.mock.calls.some(([request]) => request.method === 'daemon.voiceInference.tts.stream.cancel')).toBe(true);
        expect(speechBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    });

    it.each(['disabled', 'unavailable'] as const)(
        'reports %s execution policy without invoking any TTS implementation', async state => {
            // A warm ready observation is retained during transient failure. These vectors
            // begin on fresh Homes so the real HTTP producer proves cold fail-closed admission.
            await retireAccount();
            await restoreAccount(state);
            const onTtsFailed = vi.fn();
            await createLocalVoiceTtsController().speak(neuralRequest({ onTtsFailed }));
            expect(daemonStreamStartRpc).not.toHaveBeenCalled();
            expect(nativeSynthesize).not.toHaveBeenCalled();
            expect(expoSpeechSpeak).not.toHaveBeenCalled();
            expect(encodedAudio.start).not.toHaveBeenCalled();
            expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
                kind: 'tts_failed', reason: 'daemon_voice_inference_feature_disabled',
            }));
        },
    );

    it('reports explicit device local_neural failure without substituting OS speech', async () => {
        const filesystem = speechBoundary.reset().filesystem;
        const manifest = parseModelPackManifest({ packId: 'kokoro-controller-failure', kind: 'tts_sherpa', model: 'kokoro', version: '1',
            frontend: { lang: 'en' }, voices: [{ id: 'af_heart', title: 'Heart', sid: 0 }], defaultVoiceId: 'af_heart',
            files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx', sha256: 'a'.repeat(64), sizeBytes: 1 }] });
        filesystem.files.set(`${filesystem.root}/kokoro-controller-failure/pack.json`, new TextEncoder().encode(JSON.stringify({ manifest })));
        speechBoundary.nativeInitialize.mockRejectedValueOnce(new Error('kokoro_runtime_unavailable'));
        const onTtsFailed = vi.fn();
        await createLocalVoiceTtsController().speak(neuralRequest({ execution: 'device', packId: 'kokoro-controller-failure', onTtsFailed }));
        expect(speechBoundary.nativeInitialize).toHaveBeenCalledOnce();
        expect(daemonStreamStartRpc).not.toHaveBeenCalled();
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(encodedAudio.start).not.toHaveBeenCalled();
        expect(onTtsFailed).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'tts_failed', reason: 'kokoro_runtime_unavailable',
        }));
    });

    it('does not fall back to other TTS providers when daemon synthesis is cancelled', async () => {
        machineRpc.mockImplementationOnce(async request => {
            expect(request.method).toBe('daemon.voiceInference.tts.stream.start');
            await daemonStreamStartRpc(request.payload);
            return DaemonVoiceInferenceTtsStreamStartResponseSchema.parse({ ok: false,
                errorCode: 'cancelled', error: 'daemon_voice_inference_cancelled' });
        });
        const onTtsFailed = vi.fn();
        await expect(createLocalVoiceTtsController().speak(neuralRequest({ onTtsFailed }))).resolves.toBeUndefined();
        expect(daemonStreamStartRpc).toHaveBeenCalledOnce();
        expect(nativeSynthesize).not.toHaveBeenCalled();
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(encodedAudio.start).not.toHaveBeenCalled();
        expect(onTtsFailed).not.toHaveBeenCalled();
    });
});

function neuralRequest(input: Readonly<{
    text?: string; packId?: string; voiceId?: string | null; execution?: 'device' | 'daemon';
    onSpeaking?: () => void; onTtsFailed?: import('./localVoiceTtsProviderControllers').LocalVoiceTtsRequest['onTtsFailed'];
}> = {}): import('./localVoiceTtsProviderControllers').LocalVoiceTtsRequest {
    const defaults = readLocalConversationVoiceSettings(voiceSettingsParse({ providerId: 'local_conversation' }));
    return {
        sessionId: 'session-1', text: input.text ?? 'hello from daemon', settings: { voice: storage.getState().settings.voice },
        tts: { ...defaults.tts, provider: 'local_neural', localNeural: { ...defaults.tts.localNeural,
            assetId: input.packId ?? 'kokoro-82m-v1.0-onnx-q8-wasm',
            voiceId: input.voiceId === undefined ? 'af_heart' : input.voiceId, speed: 1,
            execution: input.execution ?? 'daemon' } },
        networkTimeoutMs: 15_000, registerPlaybackStopper: () => () => {},
        onSpeaking: input.onSpeaking ?? (() => {}), ...(input.onTtsFailed ? { onTtsFailed: input.onTtsFailed } : {}),
    };
}
