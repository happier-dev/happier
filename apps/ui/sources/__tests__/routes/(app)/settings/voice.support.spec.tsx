import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import {
    getVoiceSettingsRouteModalMockRef,
    getVoiceSettingsRouteParamsRef,
    getVoiceSettingsRouteScrollToMockRef,
    installVoiceSettingsRouteModuleMocks,
} from './voiceSettingsRouteTestHelpers';
import { VoiceAdvancedSettingsScreen } from '@/voice/settings/screens/VoiceAdvancedSettingsScreen';
import { VoiceConversationsSettingsScreen } from '@/voice/settings/screens/VoiceConversationsSettingsScreen';
import { VoiceDictationSettingsScreen } from '@/voice/settings/screens/VoiceDictationSettingsScreen';
import { VoicePrivacySettingsScreen } from '@/voice/settings/screens/VoicePrivacySettingsScreen';
import type { VoiceSettingsIntent } from '@/voice/settings/voiceSettingsIntents';

function VoiceSettingsIntentDetailsScreen(props: Readonly<{ intent: VoiceSettingsIntent }>) {
    switch (props.intent) {
        case 'dictation': return <VoiceDictationSettingsScreen />;
        case 'conversations': return <VoiceConversationsSettingsScreen />;
        case 'privacy': return <VoicePrivacySettingsScreen />;
        case 'advanced': return <VoiceAdvancedSettingsScreen />;
    }
}

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

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...(await importOriginal()),
    useAllMachines: () => [],
    useActiveServerAccountScope: () => null,
    useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
    useProfile: () => profileDefaults,
    useSettings: () => settingsParse({ voice: voiceState }),
    useSettingsVersion: () => 0,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'test-server' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canAgentResume: (agentId: string | null | undefined) => canAgentResumeSpy(agentId),
}));

const createVoiceState = (): any => voiceSettingsParse({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
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
    voiceState.providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    voiceState.assistantLanguage = null;
    voiceState.providers['happier.voice.elevenlabs/realtime-elevenlabs'].config.billingMode = 'happier';
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
        voiceState.providerId = ' happier.voice.elevenlabs/realtime-elevenlabs ';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

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
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
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
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

        expect(screen.findRowByTitle('settingsVoice.local.conversationMode')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.ttsProvider')).toBeTruthy();
    });

    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.daemonInference.execution.title')).toBeTruthy();
        expect(screen.findByTestId('voice-model-row-kokoro-82m-v1.0-onnx-q8-wasm')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.local.daemonInference.service.title')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.local.daemonInference.model.title')).toBeNull();
    });

    it('uses screen-level popover boundaries for dropdowns', async () => {
        voiceState.providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        voiceState.providers['happier.voice.elevenlabs/realtime-elevenlabs'].config.billingMode = 'byo';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);

        expect(screen.findRowByTitle('settingsVoice.privacy.shareFilePaths')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.privacy.shareToolArgs')).toBeNull();
    });

    it('renders only the selected intent detail on each destination', async () => {
        const dictation = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="dictation" />);
        expect(dictation.findByTestId('settings.voice.section.dictation')).toBeTruthy();
        expect(dictation.findRowByTitle('settingsVoice.mode.off')).toBeNull();
        standardCleanup();

        const conversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(conversations.findRowByTitle('settingsVoice.mode.off')).toBeTruthy();
        expect(conversations.findByTestId('settings.voice.section.dictation')).toBeNull();
        expect(conversations.findRowByTitle('settingsVoice.ui.orbEnabled')).toBeNull();
        standardCleanup();

        const advanced = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="advanced" />);
        expect(advanced.findRowByTitle('settingsVoice.ui.orbEnabled')).toBeTruthy();
        expect(advanced.findRowByTitle('settingsVoice.mode.off')).toBeNull();
    });

    it('shows the shared execution-machine selector on exactly the intent that requires it', async () => {
        voiceState.providerId = 'happier.voice.openai/realtime-openai';
        voiceState.dictation = {
            ...voiceState.dictation,
            sttBinding: 'explicit',
            stt: {
                ...voiceState.dictation.stt,
                provider: 'local_neural',
                localNeural: {
                    ...voiceState.dictation.stt.localNeural,
                    execution: 'daemon',
                },
            },
        };

        const dictation = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="dictation" />);
        expect(findDropdownByItemTriggerTitle(
            dictation,
            'settingsVoice.local.executionMachine.title',
        )).toBeTruthy();
        standardCleanup();

        const conversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(findDropdownByItemTriggerTitle(
            conversations,
            'settingsVoice.local.executionMachine.title',
        )).toBeNull();
        standardCleanup();

        voiceState.providerId = 'local_direct';
        const localConversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(findDropdownByItemTriggerTitle(
            localConversations,
            'settingsVoice.local.executionMachine.title',
        )).toBeTruthy();
    });

    it('keeps the selected provider disclosure in Privacy & data and the policy entry last', async () => {
        const conversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(conversations.findByTestId('settings.voice.provider.disclosure.happier.voice.elevenlabs%2Frealtime-elevenlabs')).toBeNull();
        standardCleanup();

        const privacy = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
        const disclosure = privacy.findByTestId('settings.voice.provider.disclosure.happier.voice.elevenlabs%2Frealtime-elevenlabs');
        const policy = privacy.findByTestId('settings.voice.privacyPolicy');
        expect(disclosure).toBeTruthy();
        expect(policy).toBeTruthy();

        const itemRows = privacy.tree.root.findAllByType('Item' as any);
        expect(itemRows[itemRows.length - 1]?.props.testID).toBe('settings.voice.privacyPolicy');
        expect(itemRows.indexOf(disclosure!)).toBeLessThan(itemRows.indexOf(policy!));
    });

    it('does not use confirm modals for local conversation mode selection', async () => {
        await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findRowByTitle('settingsVoice.local.conversationMode')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.conversationMode');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for fixed local voice Agent selection', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.agentSource = 'agent';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorAgentId')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.mediatorAgentId');
        });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('does not use confirm modals for other local conversation enum settings', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const resumabilityDropdown = dropdowns.find((d: any) => Array.isArray(d.props?.items) && d.props.items.some((i: any) => i?.id === 'provider_resume'));
        expect(resumabilityDropdown).toBeTruthy();

        const providerResumeItem = resumabilityDropdown!.props.items.find((i: any) => i?.id === 'provider_resume');
        expect(providerResumeItem?.disabled).toBe(true);
    });

    it('can toggle voice agent commit isolation', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.commitIsolation = false;

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
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

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findRowByTitle('settingsVoice.preferredLanguage')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.preferredLanguage');
        });

        expect(modalMockRef.current.spies.prompt).not.toHaveBeenCalled();
    });

    it('wires ElevenLabs voice dropdown selection into settings (BYO)', async () => {
        voiceState.providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        voiceState.providers['happier.voice.elevenlabs/realtime-elevenlabs'].config.billingMode = 'byo';
        decryptSecretValue.mockReturnValue('xi-test');

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        const dropdowns = screen.findAll((node) => String(node.type) === 'DropdownMenu');
        const voiceDropdown = dropdowns.find((d: any) => d.props?.search === true && d.props?.searchPlaceholder === 'settingsVoice.byo.voiceSearchPlaceholder');
        expect(voiceDropdown).toBeTruthy();

        await act(async () => {
            voiceDropdown!.props.onSelect?.('voice_test');
        });

        expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
            providers: expect.objectContaining({
                'happier.voice.elevenlabs/realtime-elevenlabs': expect.objectContaining({
                    config: expect.objectContaining({
                        tts: expect.objectContaining({ voiceId: 'voice_test' }),
                    }),
                }),
            }),
        }));
    });

    it('wires supported ElevenLabs similarity boost into settings and omits speaker boost (BYO)', async () => {
        await import('@/modal');

        voiceState.providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        voiceState.providers['happier.voice.elevenlabs/realtime-elevenlabs'].config.billingMode = 'byo';
        modalMockRef.current.spies.prompt.mockResolvedValueOnce('0.65');

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findByTestId('voice-realtime-field-tts-voiceSettings-similarityBoost')).toBeTruthy();
        expect(screen.findByTestId('voice-realtime-field-tts-voiceSettings-useSpeakerBoost')).toBeNull();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.byo.realtime.voiceSettings.similarityBoost.title');
        });

        await vi.waitFor(() => {
            expect(setVoice).toHaveBeenCalledWith(expect.objectContaining({
                providers: expect.objectContaining({
                    'happier.voice.elevenlabs/realtime-elevenlabs': expect.objectContaining({
                        config: expect.objectContaining({
                            tts: expect.objectContaining({
                                voiceSettings: expect.objectContaining({ similarityBoost: 0.65 }),
                            }),
                        }),
                    }),
                }),
            }));
        });
    });
});
