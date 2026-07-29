import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
    getVoiceSettingsRouteModalMockRef,
    getVoiceSettingsRouteParamsRef,
    getVoiceSettingsRouteScrollToMockRef,
    installVoiceSettingsRouteModuleMocks,
} from './voiceSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setVoiceProviderId = vi.fn();
const setVoice = vi.fn();
const decryptSecretValue = vi.fn<(value: unknown) => string | null>(() => null);
const resetGlobalVoiceAgentPersistenceSpy = vi.fn(async () => {});
const canAgentResumeSpy = vi.fn<(agentId: string | null | undefined) => boolean>(() => true);
const modalMockRef = getVoiceSettingsRouteModalMockRef();
const routeParamsRef = getVoiceSettingsRouteParamsRef();
const scrollToMockRef = getVoiceSettingsRouteScrollToMockRef();

installVoiceSettingsRouteModuleMocks({
    storageModule: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: () => null,
            useSettings: () => settingsParse({}),
        });
    },
});

vi.mock('@/voice/agent/resetGlobalVoiceAgentPersistence', () => ({
    resetGlobalVoiceAgentPersistence: () => resetGlobalVoiceAgentPersistenceSpy(),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        decryptSecretValue: (value: unknown) => decryptSecretValue(value),
        encryptSecretValue: () => ({ _isSecretValue: true, encryptedValue: { t: 'enc-v1', c: 'x' } }),
    },
}));

vi.mock('@/hooks/server/useHappierVoiceSupport', () => ({
    useHappierVoiceSupport: () => false,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/constants/Languages', () => ({
    LANGUAGES: [{ code: 'en', name: 'English' }],
    findLanguageByCode: () => ({ code: 'en', name: 'English' }),
    getLanguageDisplayName: () => 'English',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude', 'codex', 'opencode'],
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: {
            phase: 'idle',
            refresh: vi.fn(),
        },
    }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
    useProfile: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'test-server' }),
}));

vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canAgentResume: (agentId: string | null | undefined) => canAgentResumeSpy(agentId),
}));

const createVoiceState = (): any => ({
    providerId: 'realtime_elevenlabs',
    assistantLanguage: null,
    ui: {
        scopeDefault: 'global',
        surfaceLocation: 'auto',
        activityFeedEnabled: false,
        activityFeedAutoExpandOnStart: false,
        updates: {
            activeSession: 'summaries',
            otherSessions: 'activity',
            snippetsMaxMessages: 3,
            includeUserMessagesInSnippets: false,
            otherSessionsSnippetsMode: 'on_demand_only',
        },
    },
    privacy: {
        shareSessionSummary: true,
        shareRecentMessages: true,
        recentMessagesCount: 3,
        shareToolNames: true,
        sharePermissionRequests: true,
        shareFilePaths: false,
        shareToolArgs: false,
    },
    providers: {
        realtime_elevenlabs: { schemaVersion: 2, config: {
            mode: 'default',
            billingMode: 'happier',
            tts: {
                voiceId: 'EST9Ui6982FZPSi7gCHi',
                modelId: null,
                voiceSettings: {
                    stability: null,
                    similarityBoost: null,
                    style: null,
                    useSpeakerBoost: null,
                    speed: null,
                },
            },
            byo: { agentId: null },
        } },
	        local_direct: { schemaVersion: 1, config: {
            stt: { baseUrl: null, apiKey: null, model: 'whisper-1', useDeviceStt: false },
            tts: {
                provider: 'openai_compat',
                openaiCompat: {
                    baseUrl: null,
                    insecureLocalOriginConsent: null,
                    insecureLocalConsentMachineId: null,
                    apiKey: null,
                    model: 'tts-1',
                    voice: 'alloy',
                    format: 'mp3',
                },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
                providers: {},
                autoSpeakReplies: true,
                bargeInEnabled: true
            },
	            networkTimeoutMs: 15000,
	            handsFree: {
	                enabled: false,
	                endpointing: {
	                    silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                    minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                },
	            },
	        } },
        local_conversation: { schemaVersion: 1, config: {
            conversationMode: 'direct_session',
            stt: { baseUrl: null, apiKey: null, model: 'whisper-1', useDeviceStt: false },
            tts: {
                provider: 'openai_compat',
                openaiCompat: {
                    baseUrl: null,
                    insecureLocalOriginConsent: null,
                    insecureLocalConsentMachineId: null,
                    apiKey: null,
                    model: 'tts-1',
                    voice: 'alloy',
                    format: 'mp3',
                },
                localNeural: { model: 'kokoro', assetId: null, voiceId: null, speed: null, execution: 'auto' },
                providers: {},
                autoSpeakReplies: true,
                bargeInEnabled: true
	            },
	            networkTimeoutMs: 15000,
	            handsFree: {
	                enabled: false,
	                endpointing: {
	                    silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                    minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                },
	            },
	            agent: {
                backend: 'daemon',
                agentSource: 'session',
                agentId: 'claude',
                permissionPolicy: 'read_only',
                idleTtlSeconds: 300,
                chatModelSource: 'custom',
                chatModelId: 'default',
                commitModelSource: 'chat',
                commitModelId: 'default',
                openaiCompat: { chatBaseUrl: null, chatApiKey: null, chatModel: 'default', commitModel: 'default', temperature: 0.4, maxTokens: null },
                verbosity: 'short',
            },
            streaming: { enabled: false, ttsEnabled: false, ttsChunkChars: 200 },
        } },
    },
});

let voiceState: any = createVoiceState();

vi.mock('@/voice/settings/useVoiceSettingsMutable', () => ({
    useVoiceSettingsMutable: () => [voiceSettingsParse(voiceState), (next: any) => setVoice(next)],
}));

beforeEach(() => {
    routeParamsRef.current = {};
    scrollToMockRef.current?.mockClear();
    voiceState = createVoiceState();
    setVoice.mockClear();
    setVoiceProviderId.mockClear();
    decryptSecretValue.mockReset();
    decryptSecretValue.mockReturnValue(null);
    canAgentResumeSpy.mockReset();
    canAgentResumeSpy.mockReturnValue(true);
    voiceState.providerId = 'realtime_elevenlabs';
    voiceState.assistantLanguage = null;
    voiceState.providers.realtime_elevenlabs.config.billingMode = 'happier';
    voiceState.ui.scopeDefault = 'global';
    voiceState.ui.surfaceLocation = 'auto';
    voiceState.ui.updates.activeSession = 'summaries';
    voiceState.ui.updates.otherSessions = 'activity';
    voiceState.ui.updates.snippetsMaxMessages = 3;
    voiceState.ui.updates.includeUserMessagesInSnippets = false;
    voiceState.ui.updates.otherSessionsSnippetsMode = 'on_demand_only';
    voiceState.privacy.shareRecentMessages = true;
    voiceState.privacy.recentMessagesCount = 3;
});

function findDropdownByItemTriggerTitle(
    screen: { findAll: (predicate: (node: any) => boolean) => any[] },
    title: string,
) {
    return screen.findAll((node) => node.type === 'DropdownMenu' && node.props?.itemTrigger?.title === title)[0] ?? null;
}

afterEach(() => {
    modalMockRef.current?.spies.alert.mockClear();
    modalMockRef.current?.spies.confirm.mockClear();
    modalMockRef.current?.spies.prompt.mockClear();
    standardCleanup();
});

describe('VoiceSettingsScreen (server voice unsupported)', () => {
    it('keeps Happier Voice visible but disabled without destroying the unavailable hosted selection', async () => {
        voiceState.providerId = ' realtime_elevenlabs ';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findRowByTitle('settingsVoice.mode.off')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.mode.local')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.mode.byo')).toBeTruthy();
        const hostedRow = screen.findRowByTitle('settingsVoice.mode.happier');
        expect(hostedRow).toBeTruthy();
        expect(hostedRow?.props.disabled).toBe(true);
        expect(hostedRow?.props.onPress).toBeUndefined();
        expect(setVoice).not.toHaveBeenCalled();
    });
});

describe('VoiceSettingsScreen (voice settings UX)', () => {
    it('scrolls the stable Privacy section into view once for the validated route focus', async () => {
        routeParamsRef.current = { focus: 'privacy' };
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const list = screen.tree.root.findByType('ItemList' as any);
        const privacySection = screen.findByTestId('settings.voice.section.privacy');

        expect(privacySection).toBeTruthy();
        expect(scrollToMockRef.current).toBeTruthy();

        await act(async () => {
            list.props.onContentSizeChange(0, 1800);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
            list.props.onLayout({
                nativeEvent: { layout: { y: 0, height: 400 } },
            });
        });

        expect(scrollToMockRef.current).toHaveBeenCalledTimes(1);
        expect(scrollToMockRef.current).toHaveBeenCalledWith({
            y: 1160,
            animated: false,
        });

        await act(async () => {
            list.props.onContentSizeChange(0, 1900);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
        });
        expect(scrollToMockRef.current).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unknown'],
        [''],
        [['unknown', 'privacy']],
    ])('ignores unsupported or malformed Voice settings focus %j', async (focus) => {
        routeParamsRef.current = { focus };
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const list = screen.tree.root.findByType('ItemList' as any);
        const privacySection = screen.findByTestId('settings.voice.section.privacy');

        await act(async () => {
            list.props.onContentSizeChange(0, 1800);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
            list.props.onLayout({
                nativeEvent: { layout: { y: 0, height: 400 } },
            });
        });

        expect(scrollToMockRef.current).not.toHaveBeenCalled();
    });

    it('renders local conversation settings when providerId is padded', async () => {
        voiceState.providerId = ' local_conversation ';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findRowByTitle('settingsVoice.local.conversationMode')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.ttsProvider')).toBeTruthy();
    });

    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.ttsProvider')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.autoSpeak')).toBeTruthy();
    });

    it('renders the shared selected-daemon model-pack row for web local-neural TTS', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.tts = {
            provider: 'local_neural',
            autoSpeakReplies: true,
            bargeInEnabled: true,
            openaiCompat: { baseUrl: null, apiKey: null, model: 'tts-1', voice: 'alloy', format: 'mp3' },
            providers: {},
            localNeural: {
                model: 'kokoro',
                assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                voiceId: 'af_heart',
                speed: 1,
                execution: 'device',
            },
        };

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.daemonInference.execution.title')).toBeTruthy();
        expect(screen.findByTestId('voice-model-row-kokoro-82m-v1.0-onnx-q8-wasm')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.daemonInference.service.title')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.local.daemonInference.model.title')).toBeNull();
    });

    it('uses screen-level popover boundaries for dropdowns', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.providers.realtime_elevenlabs.config.billingMode = 'byo';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        expect(dropdowns.length).toBeGreaterThan(0);

        const boundaryRef = dropdowns[0]!.props.popoverBoundaryRef;
        expect(boundaryRef).toBeTruthy();
        expect(typeof boundaryRef).toBe('object');
        expect('current' in boundaryRef).toBe(true);

        for (const dropdown of dropdowns) {
            expect(dropdown.props.popoverBoundaryRef).toBe(boundaryRef);
        }
    });

    it('does not show navigation chevrons for voice mode selection rows', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const modeItems = [
            screen.findRowByTitle('settingsVoice.mode.off'),
            screen.findRowByTitle('settingsVoice.mode.byo'),
            screen.findRowByTitle('settingsVoice.mode.local'),
        ].filter(Boolean);

        expect(modeItems.length).toBeGreaterThan(0);
        for (const item of modeItems as any[]) {
            expect(item.props.showChevron).toBe(false);
        }
    });

    it('does not render ineffective privacy toggles (file paths/tool args) as interactive settings', async () => {
        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        expect(screen.findRowByTitle('settingsVoice.privacy.shareFilePaths')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.privacy.shareToolArgs')).toBeNull();
    });

    it('does not use confirm modals for local conversation mode selection', async () => {
        await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversationMode')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversationMode');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for local voice agent backend selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorBackend')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.mediatorBackend');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for other local conversation enum settings', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);

        const pressByTitle = async (title: string) => {
            expect(screen.findRowByTitle(title)).toBeTruthy();
            await act(async () => {
                await screen.pressRowByTitle(title);
            });
        };

        await pressByTitle('settingsVoice.local.mediatorAgentSource');
        await pressByTitle('settingsVoice.local.mediatorPermissionPolicy');
        await pressByTitle('settingsVoice.local.mediatorChatModelSource');
        await pressByTitle('settingsVoice.local.mediatorCommitModelSource');
        await pressByTitle('settingsVoice.local.mediatorVerbosity');

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('disables provider resume when the selected fixed agent does not support vendor resume', async () => {
        canAgentResumeSpy.mockImplementation((agentId) => agentId !== 'unknown-agent');
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.agentSource = 'agent';
        voiceState.providers.local_conversation.config.agent.agentId = 'unknown-agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const resumabilityDropdown = dropdowns.find((d: any) => Array.isArray(d.props?.items) && d.props.items.some((i: any) => i?.id === 'provider_resume'));
        expect(resumabilityDropdown).toBeTruthy();

        const providerResumeItem = resumabilityDropdown!.props.items.find((i: any) => i?.id === 'provider_resume');
        expect(providerResumeItem?.disabled).toBe(true);
    });

    it('can toggle voice agent commit isolation', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.backend = 'daemon';
        voiceState.providers.local_conversation.config.agent.commitIsolation = false;

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversation.commitIsolation.title')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversation.commitIsolation.title');
        });

        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        config: expect.objectContaining({
                            agent: expect.objectContaining({
                                commitIsolation: true,
                            }),
                        }),
                    }),
                }),
            }),
        );
    });

    it('can reset persistent local voice agent state and bumps the transcript epoch', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        resetGlobalVoiceAgentPersistenceSpy.mockClear();
        modalMockRef.current.spies.confirm.mockResolvedValueOnce(true);

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.conversation.resetVoiceAgent.title')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversation.resetVoiceAgent.title');
        });

        expect(resetGlobalVoiceAgentPersistenceSpy).toHaveBeenCalledTimes(1);
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('clamps voice agent idle TTL to 6 hours', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        modalMockRef.current.spies.prompt.mockResolvedValueOnce('999999');

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorIdleTtl')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.mediatorIdleTtl');
        });

        expect(setVoice).toHaveBeenCalledWith(
            expect.objectContaining({
                providers: expect.objectContaining({
                    local_conversation: expect.objectContaining({
                        config: expect.objectContaining({
                            agent: expect.objectContaining({ idleTtlSeconds: 21600 }),
                        }),
                    }),
                }),
            }),
        );
    });

    it('does not use confirm modals for local TTS format selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_direct';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.local.ttsFormat')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.ttsFormat');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use prompt modals for voice assistant language selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'off';
        voiceState.assistantLanguage = null;

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        expect(screen.findRowByTitle('settingsVoice.preferredLanguage')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.preferredLanguage');
        });

        expect(modalMockRef.current.spies.prompt).not.toHaveBeenCalled();
    });

    it('wires ElevenLabs voice dropdown selection into settings (BYO)', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.providers.realtime_elevenlabs.config.billingMode = 'byo';
        decryptSecretValue.mockReturnValue('xi-test');

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const voiceDropdown = dropdowns.find((d: any) => d.props?.search === true && d.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder');
        expect(voiceDropdown).toBeTruthy();

        await act(async () => {
            voiceDropdown!.props.onSelect?.('voice_test');
        });

        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providers: expect.objectContaining({
                realtime_elevenlabs: expect.objectContaining({
                    config: expect.objectContaining({
                        tts: expect.objectContaining({ voiceId: 'voice_test' }),
                    }),
                }),
            }),
        }));
    });

    it('wires ElevenLabs speaker boost tri-state into settings (BYO)', async () => {
        voiceState.providerId = 'realtime_elevenlabs';
        voiceState.providers.realtime_elevenlabs.config.billingMode = 'byo';

        const VoiceSettingsScreen = (await import('@/app/(app)/settings/voice')).default;
        const screen = await renderSettingsView(<VoiceSettingsScreen />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const boostDropdown = dropdowns.find((d: any) => {
            const items = d.props?.items;
            if (!Array.isArray(items)) return false;
            const ids = items.map((i: any) => i?.id);
            return ids.includes('') && ids.includes('true') && ids.includes('false');
        });
        expect(boostDropdown).toBeTruthy();

        await act(async () => {
            boostDropdown!.props.onSelect?.('false');
        });

        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providers: expect.objectContaining({
                realtime_elevenlabs: expect.objectContaining({
                    config: expect.objectContaining({
                        tts: expect.objectContaining({
                            voiceSettings: expect.objectContaining({ useSpeakerBoost: false }),
                        }),
                    }),
                }),
            }),
        }));
    });
});
