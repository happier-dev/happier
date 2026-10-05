import React from 'react';
import { useRouter } from 'expo-router';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
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
import { VOICE_ADVANCED_SETTINGS, VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import { getVoiceContributedSettingsDeclarations } from '@/voice/settings/voiceContributedSettingsDeclarations';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';

function VoiceSettingsIntentDetailsScreen(props: Readonly<{ intent: VoiceSettingsIntent }>) {
    const navigation = useRouter();
    // Workspace destinations carry scalar query values; Expo also admits malformed/array focus fixtures.
    const params = Object.fromEntries(Object.entries(routeParamsRef.current)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    let screen: React.ReactElement;
    switch (props.intent) {
        case 'dictation': screen = <VoiceDictationSettingsScreen />; break;
        case 'conversations': screen = <VoiceConversationsSettingsScreen />; break;
        case 'privacy': screen = <VoicePrivacySettingsScreen />; break;
        case 'advanced': screen = <VoiceAdvancedSettingsScreen />; break;
    }
    return <DestinationInstanceHost tabId="voice-support" ref={{ kind: 'settings', params }}
        pathname={`/settings/voice/${props.intent}`} focused visible navigation={navigation}>
        {screen}
    </DestinationInstanceHost>;
}

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

/**
 * Types into the real inline field and leaves it, exercising its draft and commit owner.
 */
async function commitInlineField(
    screen: SettingsScreen,
    fieldTestID: string,
    text: string,
): Promise<void> {
    const field = () => {
        const input = screen.findByTestId(fieldTestID);
        if (!input?.props.onChangeText || !input.props.onBlur) throw new Error('Missing the inline field input');
        return input.props;
    };
    await act(async () => {
        field().onChangeText(text);
    });
    await act(async () => {
        field().onBlur();
    });
}

const setVoiceProviderId = vi.fn();
const setVoice = vi.fn();
const decryptSecretValue = vi.fn<(value: unknown) => string | null>(() => null);
const resetGlobalVoiceAgentPersistenceSpy = vi.fn(async () => {});
const canAgentResumeSpy = vi.fn<(agentId: string | null | undefined) => boolean>(() => true);
const modalMockRef = getVoiceSettingsRouteModalMockRef();
const routeParamsRef = getVoiceSettingsRouteParamsRef();
const scrollToMockRef = getVoiceSettingsRouteScrollToMockRef();

installVoiceSettingsRouteModuleMocks({
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        const defaults = settingsParse({});
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => defaults[key] }),
                useSettings: () => defaults,
            },
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

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const { createStableStorageReader } = await import('@/dev/testkit/mocks/storage');
    return {
        ...(await importOriginal()),
        useAllMachines: () => [],
        useActiveServerAccountScope: () => null,
        useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
        useProfile: () => profileDefaults,
        useSettings: createStableStorageReader(() => settingsParse({ voice: voiceState })),
        useSettingsVersion: () => 0,
    };
});

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

beforeEach(async () => {
    // Feature policy remains real. Only the advertised server capabilities cross HTTP.
    await upsertAndActivateServer({ serverUrl: 'https://voice-support.example.test', scope: 'tab' });
    resetServerFeaturesClientForTests();
    setRuntimeFetch(vi.fn(async () => Response.json(buildServerFeaturesResponse({ voiceEnabled: true }))));
    storage.setState({ settings: settingsParse({
        experiments: true,
        featureToggles: { 'voice.agent': true, 'execution.runs': true },
    }) });
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

/** Picks an option other than the current one on the segmented row titled `title`. */
async function chooseOtherSegmentedOption(
    screen: Readonly<{ findAll: (predicate: (node: any) => boolean) => any[] }>,
    title: string,
) {
    const choice = screen.findAll((node) => (
        Array.isArray(node.props?.options) && typeof node.props?.onChange === 'function' && node.props?.title === title
    ))[0];
    expect(choice).toBeTruthy();
    const next = choice.props.options.find((option: { id: string }) => option.id !== choice.props.value);
    expect(next).toBeTruthy();
    await act(async () => {
        choice.props.onChange(next.id);
    });
}

/** Opens "Advanced agent behaviour" on the Conversations page (lifecycle, commit and streaming rows). */
async function openAdvancedAgent(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    const disclosure = screen.findAll((node) => node.props?.testID === 'settings.voice.local.advancedAgent'
        && typeof node.props?.onExpandedChange === 'function')[0];
    expect(disclosure).toBeTruthy();
    await act(async () => {
        disclosure!.props.onExpandedChange(true);
    });
}

describe('VoiceSettingsScreen (server voice unsupported)', () => {
    it('keeps Happier Voice visible but disabled without destroying the unavailable hosted selection', async () => {
        voiceState.providerId = ' happier.voice.elevenlabs/realtime-elevenlabs ';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

        expect(screen.findByTestId('settings.voice.provider.off')).toBeTruthy();
        // One ElevenLabs service; who pays is its own choice, and the hosted option says why it is unavailable.
        const payWith = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.provider.payWith')[0];
        expect(payWith).toBeTruthy();
        const hosted = payWith!.props.options.find((option: { id: string }) => option.id === 'happier');
        expect(hosted?.unavailableReason).toBeTruthy();
        expect(payWith!.props.options.find((option: { id: string }) => option.id === 'byo')).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });
});

describe('VoiceSettingsScreen (voice settings UX)', () => {
    it.each(['silenceMs', 'assistantLanguage', 'greeting'] as const)('reveals a searched %s preference while conversations are off without selecting a service', async (id) => {
        voiceState.providerId = 'off';
        const setting = VOICE_CONVERSATIONS_SETTINGS.settings[id];
        routeParamsRef.current = { setting: setting.anchor };
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        const prerequisite = screen.findByTestId('settings.voice.searchPrerequisite');
        expect(prerequisite?.props.disabled).toBe(true);
        expect(prerequisite?.props.subtitle).toBe(id === 'silenceMs'
            ? 'settingsVoice.pages.search.select(choice=settingsVoice.mode.local,control=settingsVoice.providerSectionTitle)'
            : 'settingsVoice.pages.search.chooseService');
        expect(screen.findByTestId(`setting-reveal.${setting.anchor}`)).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('reveals the named prerequisite for a searched unselected contributed service field', async () => {
        voiceState.providerId = 'off';
        const declaration = getVoiceContributedSettingsDeclarations().find((page) => page.pageId === 'voiceConversations'
            && page.sections['provider.happier.voice.elevenlabs/realtime-elevenlabs']);
        const setting = declaration?.settings['provider.happier.voice.elevenlabs/realtime-elevenlabs.agentId'];
        expect(setting).toBeTruthy();
        routeParamsRef.current = { setting: setting!.anchor };
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.subtitle).toContain('ElevenLabs');
        expect(screen.findByTestId(`setting-reveal.${setting!.anchor}`)).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('reveals the speech engine prerequisite for a searched dictation model without changing its engine', async () => {
        voiceState.dictation.sttBinding = 'explicit';
        voiceState.dictation.stt.provider = 'device';
        routeParamsRef.current = { setting: VOICE_DICTATION_SETTINGS.settings.sttAssetId.anchor };
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="dictation" />);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.subtitle).toContain('choice=settingsVoice.local.localNeuralStt.provider.title');
        expect(screen.findByTestId(`setting-reveal.${VOICE_DICTATION_SETTINGS.settings.sttAssetId.anchor}`)).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('reveals the account choice for a searched provider field hidden by hosted billing', async () => {
        const declaration = getVoiceContributedSettingsDeclarations().find((page) => page.pageId === 'voiceConversations'
            && page.sections['provider.happier.voice.elevenlabs/realtime-elevenlabs']);
        const setting = declaration?.settings['provider.happier.voice.elevenlabs/realtime-elevenlabs.agentId'];
        expect(setting).toBeTruthy();
        routeParamsRef.current = { setting: setting!.anchor };
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.subtitle).toContain('control=settingsVoice.pages.conversations.payWithTitle');
        expect(screen.findByTestId(`setting-reveal.${setting!.anchor}`)).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('reveals the selectable Local service before an agent preference retained under local direct', async () => {
        voiceState.providerId = 'local_direct';
        routeParamsRef.current = { setting: VOICE_CONVERSATIONS_SETTINGS.settings.maxWarmRoots.anchor };
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findByTestId('settings.voice.searchPrerequisite')?.props.subtitle).toContain('choice=settingsVoice.mode.local,control=settingsVoice.providerSectionTitle');
        expect(setVoice).not.toHaveBeenCalled();
    });


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

        expect(screen.findRowByTitle('settingsVoice.pages.conversations.talkToTitle')).toBeTruthy();
        expect(screen.findRowByTitle('settingsVoice.pages.conversations.voiceEngineTitle')).toBeTruthy();
    });

    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.voiceEngineTitle')).toBeTruthy();
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

    it('does not render ineffective privacy toggles (file paths/tool args) as interactive settings', async () => {
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);

        expect(screen.findRowByTitle('settingsVoice.privacy.shareFilePaths')).toBeNull();
        expect(screen.findRowByTitle('settingsVoice.privacy.shareToolArgs')).toBeNull();
    });

    it('renders only the selected intent detail on each destination', async () => {
        const dictation = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="dictation" />);
        expect(dictation.findByTestId('settings.voice.section.dictation')).toBeTruthy();
        expect(dictation.findByTestId('settings.voice.provider.off')).toBeNull();
        standardCleanup();

        const conversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(conversations.findByTestId('settings.voice.provider.off')).toBeTruthy();
        expect(conversations.findByTestId('settings.voice.section.dictation')).toBeNull();
        expect(conversations.findRowByTitle(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey)).toBeNull();
        standardCleanup();

        const advanced = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="advanced" />);
        const presence = advanced.findRowByTitle(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey);
        expect(presence).toBeTruthy();
        expect(presence?.props.rightElement.props.testIdPrefix).toBe('settings.voice.ui.presenceContainer');
        expect(advanced.findByTestId('settings.voice.provider.off')).toBeNull();
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
        expect(dictation.findByTestId('settings.voice.executionMachine.chip')).toBeTruthy();
        standardCleanup();

        const conversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(conversations.findByTestId('settings.voice.executionMachine.chip')).toBeNull();
        standardCleanup();

        voiceState.providerId = 'local_direct';
        const localConversations = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(localConversations.findByTestId('settings.voice.executionMachine.chip')).toBeTruthy();
    });

    it('keeps the selected provider disclosure in Privacy & data and the policy entry last', async () => {
        // This used to also render the Conversations screen and assert the disclosure
        // row was absent there. That assertion could not fail: with the suppression
        // flag forced on, the screen still never renders the selected provider's
        // declarative settings group in this harness, so it stayed green either way.
        // Privacy & data owning the copy is the contract worth asserting, and the
        // provider panels no longer contain a second renderer to guard against.
        const privacy = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
        const disclosure = privacy.findByTestId('settings.voice.provider.disclosure.happier.voice.elevenlabs%2Frealtime-elevenlabs');
        const policy = privacy.findByTestId('settings.voice.privacyPolicy');
        expect(disclosure).toBeTruthy();
        expect(policy).toBeTruthy();
        expect(String(disclosure?.props.subtitle)).toContain(
            'Audio and conversation content are sent from this device to ElevenLabs',
        );

        const itemRows = privacy.tree.root.findAllByType('Item' as any);
        expect(itemRows[itemRows.length - 1]?.props.testID).toBe('settings.voice.privacyPolicy');
        expect(itemRows.indexOf(disclosure!)).toBeLessThan(itemRows.indexOf(policy!));
    });

    it('does not use confirm modals for local conversation mode selection', async () => {
        await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        // Two short, always-visible options: choosing one is a single tap on a segmented row.
        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.talkToTitle');

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
        await openAdvancedAgent(screen);

        await chooseOtherSegmentedOption(screen, 'settingsVoice.local.mediatorAgentSource');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.itMayTitle');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.local.mediatorChatModelSource');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.local.mediatorCommitModelSource');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.repliesTitle');

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
    });

    it('disables provider resume when the selected fixed agent does not support vendor resume', async () => {
        canAgentResumeSpy.mockImplementation((agentId) => agentId !== 'unknown-agent');
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.agentSource = 'agent';
        voiceState.providers.local_conversation.config.agent.agentId = 'unknown-agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
        const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
        expect(restore).toBeTruthy();
        const providerResume = restore!.props.options.find((option: { id: string }) => option.id === 'provider_resume');
        expect(providerResume?.unavailableReason).toBeTruthy();
    });

    it('can toggle voice agent commit isolation', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.commitIsolation = false;

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        await openAdvancedAgent(screen);
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

    it('does not offer commit isolation when the Agent prerequisite is disabled', async () => {
        storage.getState().applySettingsLocal({ featureToggles: { 'voice.agent': false, 'execution.runs': true } });
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        await openAdvancedAgent(screen);
        expect(screen.findRowByTitle('settingsVoice.local.conversation.commitIsolation.title')).toBeNull();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('can reset persistent local voice agent state and bumps the transcript epoch', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        resetGlobalVoiceAgentPersistenceSpy.mockClear();
        modalMockRef.current.spies.confirm.mockResolvedValueOnce(true);

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="privacy" />);
        const forget = screen.findRowByTitle('settingsVoice.pages.privacy.forgetTitle')?.props.rightElement;
        expect(forget?.props.testID).toBe('settings.voice.memory.forget');

        await act(async () => {
            forget!.props.onPress();
        });
        await act(async () => {});

        expect(modalMockRef.current.spies.confirm).toHaveBeenCalledTimes(1);
        expect(resetGlobalVoiceAgentPersistenceSpy).toHaveBeenCalledTimes(1);
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('clamps voice agent idle TTL to 6 hours', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        await openAdvancedAgent(screen);
        expect(screen.findRowByTitle('settingsVoice.local.mediatorIdleTtl')).toBeTruthy();

        await commitInlineField(screen, 'settings.voice.local.idleTtlSeconds.field', '999999');

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
        // Device speech is the default engine and has no format; the OpenAI-compatible engine does.
        voiceState.providers.local_direct.config.tts = {
            ...voiceState.providers.local_direct.config.tts,
            provider: 'happier.voice.openai-compat/tts',
        };
        const providerId = voiceState.providers.local_direct.config.tts.provider;
        const settingsOwner = createDefaultVoiceProviderRegistry().get(providerId)?.providerSettings;
        expect(settingsOwner).toBeTruthy();
        voiceState = writeVoiceProviderSettingsConfig(voiceState, providerId, settingsOwner!.defaultConfig);

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findRowByTitle('settingsVoice.local.ttsFormat')).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle('settingsVoice.local.ttsFormat');
        });
        const format = findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.ttsFormat');
        expect(format).toBeTruthy();
        await act(async () => { format!.props.onSelect('wav'); });

        expect(modalMockRef.current.spies.confirm).not.toHaveBeenCalled();
        const written = setVoice.mock.calls.at(-1)?.[0];
        expect(written.providers[providerId].config.format).toBe('wav');
        expect(written.providerId).toBe('local_direct');
    });

    it('keeps Reply in apart from the language the speech model listens for', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_direct';
        voiceState.assistantLanguage = null;
        const stt = voiceState.providers.local_direct.config.stt;
        voiceState.providers.local_direct.config.stt = {
            ...stt,
            provider: 'local_neural',
            localNeural: { ...stt.localNeural, language: 'fr' },
        };

        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        // I speak reads the speech model's own language; Reply in is the reply preference.
        expect(screen.findByTestId('settings.voice.language.iSpeak')?.props.detail).toBe('fr');
        const replyIn = findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.replyInTitle');
        expect(replyIn?.props.selectedId).toBe('same');

        await act(async () => {
            replyIn!.props.onSelect('en');
        });

        expect(modalMockRef.current.spies.prompt).not.toHaveBeenCalled();
        const written = setVoice.mock.calls.at(-1)?.[0];
        expect(written.assistantLanguage).toBe('en');
        expect(written.providers.local_direct.config.stt.localNeural.language).toBe('fr');
        expect(written.providers.local_direct.config.stt.provider).toBe('local_neural');
    });

    it('has no Language section while conversations are off', async () => {
        voiceState.providerId = 'off';
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.replyInTitle')).toBeNull();
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
        const screen = await renderSettingsView(<VoiceSettingsIntentDetailsScreen intent="conversations" />);
        expect(screen.findByTestId('voice-realtime-field-tts-voiceSettings-similarityBoost')).toBeTruthy();
        expect(screen.findByTestId('voice-realtime-field-tts-voiceSettings-useSpeakerBoost')).toBeNull();

        await commitInlineField(
            screen,
            'voice-realtime-field-tts-voiceSettings-similarityBoost.field',
            '0.65',
        );

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
