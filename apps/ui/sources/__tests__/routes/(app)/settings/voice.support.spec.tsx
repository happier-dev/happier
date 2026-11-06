import React from 'react';
import 'fake-indexeddb/auto';
import type { ScrollViewProps } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings, readVoiceProviderSettingsConfig, voiceSettingsParse, writeLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import type { VoiceSettingsIntent } from '@/voice/settings/voiceSettingsIntents';
import { ModalProvider } from '@/modal';
import { t, tLoose } from '@/text';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

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
    return (
        <InjectedAuthProvider credentials={account?.credentials ?? null}>
            <ModalProvider>
            <DestinationInstanceHost tabId="voice-support" ref={{ kind: 'settings', params }}
                pathname={`/settings/voice/${props.intent}`} focused visible navigation={navigation}>
                {screen}
            </DestinationInstanceHost>
            </ModalProvider>
        </InjectedAuthProvider>
    );
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type SettingsScreen = Awaited<ReturnType<typeof renderSettingsView>>;

function findItemByTestId(screen: SettingsScreen, testID: string) {
    return screen.findAll((node) => node.props.testID === testID && typeof node.props.title === 'string')[0] ?? null;
}

/**
 * Types into the real inline field and leaves it, exercising its draft and commit owner.
 */
async function commitInlineField(
    screen: SettingsScreen,
    fieldTestID: string,
    text: string,
): Promise<void> {
    const field = () => {
        const input = screen.findAll((node) => node.props.testID === fieldTestID
            && typeof node.props.onChangeText === 'function' && typeof node.props.onBlur === 'function')[0];
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

const routeParamsRef = vi.hoisted(() => ({ current: {} as Record<string, string | string[] | undefined> }));
const scrollTo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    // The native scroll handle is the only synthetic part of focus scrolling; ItemList and its registry remain real.
    return createReactNativeWebMock({ ScrollView: React.forwardRef<{ scrollTo: typeof scrollTo }, ScrollViewProps>(
        (props, ref) => {
            React.useImperativeHandle(ref, () => ({ scrollTo }), []);
            return React.createElement('ScrollView', props, props.children);
        },
    ) });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Only third-party renderer/portal leaves are synthetic; modal admission and lifecycle stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/utils/web/reactDomCjs', () => ({ requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }) }));
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeParamsRef.current }).module);
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
const { useRouter } = await import('expo-router');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { buildServerFeaturesResponse } = await import('@/hooks/server/serverFeaturesTestUtils');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { VoiceAdvancedSettingsScreen } = await import('@/voice/settings/screens/VoiceAdvancedSettingsScreen');
const { VoiceConversationsSettingsScreen } = await import('@/voice/settings/screens/VoiceConversationsSettingsScreen');
const { VoiceDictationSettingsScreen } = await import('@/voice/settings/screens/VoiceDictationSettingsScreen');
const { VoicePrivacySettingsScreen } = await import('@/voice/settings/screens/VoicePrivacySettingsScreen');
const { VOICE_ADVANCED_SETTINGS, VOICE_CONVERSATIONS_SETTINGS, VOICE_DICTATION_SETTINGS } = await import('@/voice/settings/voiceSettingsDeclarations');
const { getVoiceContributedSettingsDeclarations } = await import('@/voice/settings/voiceContributedSettingsDeclarations');
const { createDefaultVoiceProviderRegistry } = await import('@/voice/registry/defaultRegistry');

// These provider-owned configuration bags are produced by the canonical schema, not copied fixtures.
const createVoiceState = (): any => voiceSettingsParse({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
});

let voiceState: any = createVoiceState();
let voiceAgentEnabled = true;
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>> | null = null;
let restorePopoverWebGlobals: (() => void) | null = null;

async function renderVoiceSettings(intent: VoiceSettingsIntent) {
    if (!account) {
        const settings = settingsParse({ experiments: true,
            featureToggles: { 'voice.agent': voiceAgentEnabled, 'execution.runs': true }, voice: voiceState });
        account = await createVoiceSettingsAccountTestHarness(settingsParse({
            ...settings, ...normalizeVoiceSettingsLocalDelta({ voice: settings.voice }, settings),
        }));
        const request = account.request.getMockImplementation()!;
        account.request.mockImplementation((input, init) => {
            if (new URL(String(input)).pathname.startsWith('/v1/features')) {
                return Promise.resolve(Response.json(buildServerFeaturesResponse({ voiceEnabled: true, happierVoiceEnabled: false })));
            }
            return request(input, init);
        });
    } else account.replaceVoice(voiceSettingsParse(voiceState));
    return renderSettingsView(<VoiceSettingsIntentDetailsScreen intent={intent} />);
}

beforeEach(() => {
    restorePopoverWebGlobals = withPopoverWebGlobals();
    voiceAgentEnabled = true;
    routeParamsRef.current = {};
    scrollTo.mockClear();
    voiceState = createVoiceState();
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
    return screen.findAll((node) => node.type === DropdownMenu && node.props?.itemTrigger?.title === tLoose(title))[0] ?? null;
}

afterEach(async () => {
    standardCleanup();
    restorePopoverWebGlobals?.();
    restorePopoverWebGlobals = null;
    await account?.dispose();
    account = null;
});

/** Picks an option other than the current one on the segmented row titled `title`. */
async function chooseOtherSegmentedOption(
    screen: Readonly<{ findAll: (predicate: (node: any) => boolean) => any[] }>,
    title: string,
) {
    const choice = screen.findAll((node) => (
        Array.isArray(node.props?.options) && typeof node.props?.onChange === 'function' && node.props?.title === tLoose(title)
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

        const screen = await renderVoiceSettings("conversations");

        expect(screen.findByTestId('settings.voice.provider.off')).toBeTruthy();
        // One ElevenLabs service; who pays is its own choice, and the hosted option says why it is unavailable.
        const payWith = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.provider.payWith')[0];
        expect(payWith).toBeTruthy();
        const hosted = payWith!.props.options.find((option: { id: string }) => option.id === 'happier');
        expect(hosted?.unavailableReason).toBeTruthy();
        expect(payWith!.props.options.find((option: { id: string }) => option.id === 'byo')).toBeTruthy();
        expect(account!.writes).toEqual([]);
    });
});

describe('VoiceSettingsScreen (voice settings UX)', () => {
    it.each(['silenceMs', 'assistantLanguage', 'greeting'] as const)('reveals a searched %s preference while conversations are off without selecting a service', async (id) => {
        voiceState.providerId = 'off';
        const setting = VOICE_CONVERSATIONS_SETTINGS.settings[id];
        routeParamsRef.current = { setting: setting.anchor };
        const screen = await renderVoiceSettings("conversations");
        const prerequisite = findItemByTestId(screen, 'settings.voice.searchPrerequisite');
        expect(prerequisite?.props.disabled).toBe(true);
        expect(prerequisite?.props.subtitle).toBe(id === 'silenceMs'
            ? t('settingsVoice.pages.search.select', { choice: t('settingsVoice.mode.local'), control: t('settingsVoice.providerSectionTitle') })
            : t('settingsVoice.pages.search.chooseService'));
        expect(screen.findByTestId(`setting-reveal.${setting.anchor}`)).toBeTruthy();
        expect(account!.writes).toEqual([]);
    });

    it('reveals Hands-free timing through its switch while Hands-free is off', async () => {
        voiceState.providerId = 'local_conversation';
        const setting = VOICE_CONVERSATIONS_SETTINGS.settings.silenceMs;
        routeParamsRef.current = { setting: setting.anchor };
        const screen = await renderVoiceSettings("conversations");
        // The timing rows belong to Hands-free: while it is off they are not drawn, and a search lands on
        // the one prerequisite row that says how to reach them.
        expect(screen.findAll((node) => node.props?.fieldTestID === 'settings.voice.local.handsFree.silenceMs.field')).toHaveLength(0);
        const prerequisite = findItemByTestId(screen, 'settings.voice.searchPrerequisite');
        expect(prerequisite?.props.disabled).toBe(true);
        expect(prerequisite?.props.subtitle).toBe(t('settingsVoice.pages.conversations.handsFreeTimingUnavailable'));
        expect(account!.writes).toEqual([]);
    });

    it('reveals the named prerequisite for a searched unselected contributed service field', async () => {
        voiceState.providerId = 'off';
        const declaration = getVoiceContributedSettingsDeclarations().find((page) => page.pageId === 'voiceConversations'
            && page.sections['provider.happier.voice.elevenlabs/realtime-elevenlabs']);
        const setting = declaration?.settings['provider.happier.voice.elevenlabs/realtime-elevenlabs.agentId'];
        expect(setting).toBeTruthy();
        routeParamsRef.current = { setting: setting!.anchor };
        const screen = await renderVoiceSettings("conversations");
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.disabled).toBe(true);
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.subtitle).toContain('ElevenLabs');
        expect(screen.findByTestId(`setting-reveal.${setting!.anchor}`)).toBeTruthy();
        expect(account!.writes).toEqual([]);
    });

    it('reveals the speech engine prerequisite for a searched dictation model without changing its engine', async () => {
        voiceState.dictation.sttBinding = 'explicit';
        voiceState.dictation.stt.provider = 'device';
        routeParamsRef.current = { setting: VOICE_DICTATION_SETTINGS.settings.sttAssetId.anchor };
        const screen = await renderVoiceSettings("dictation");
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.disabled).toBe(true);
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.subtitle).toContain(t('settingsVoice.local.localNeuralStt.provider.title'));
        expect(screen.findByTestId(`setting-reveal.${VOICE_DICTATION_SETTINGS.settings.sttAssetId.anchor}`)).toBeTruthy();
        expect(account!.writes).toEqual([]);
    });

    it('reveals the account choice for a searched provider field hidden by hosted billing', async () => {
        const declaration = getVoiceContributedSettingsDeclarations().find((page) => page.pageId === 'voiceConversations'
            && page.sections['provider.happier.voice.elevenlabs/realtime-elevenlabs']);
        const setting = declaration?.settings['provider.happier.voice.elevenlabs/realtime-elevenlabs.agentId'];
        expect(setting).toBeTruthy();
        routeParamsRef.current = { setting: setting!.anchor };
        const screen = await renderVoiceSettings("conversations");
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.subtitle).toContain(t('settingsVoice.pages.conversations.payWithTitle'));
        expect(screen.findByTestId(`setting-reveal.${setting!.anchor}`)).toBeTruthy();
        expect(account!.writes).toEqual([]);
    });

    it('reveals the selectable Local service before an agent preference retained under local direct', async () => {
        voiceState.providerId = 'local_direct';
        routeParamsRef.current = { setting: VOICE_CONVERSATIONS_SETTINGS.settings.idleTtlSeconds.anchor };
        const screen = await renderVoiceSettings("conversations");
        expect(findItemByTestId(screen, 'settings.voice.searchPrerequisite')?.props.subtitle).toContain(t('settingsVoice.pages.search.select', { choice: t('settingsVoice.mode.local'), control: t('settingsVoice.providerSectionTitle') }));
        expect(account!.writes).toEqual([]);
    });


    it('scrolls the stable Privacy section into view once for the validated route focus', async () => {
        routeParamsRef.current = { focus: 'privacy' };
        const screen = await renderVoiceSettings("privacy");
        const list = screen.tree.root.findByType(ItemList);
        const privacySection = screen.findByTestId('settings.voice.section.privacy');

        expect(privacySection).toBeTruthy();
        expect(scrollTo).toBeTruthy();
        const { onContentSizeChange, onLayout } = list.props;
        if (!onContentSizeChange || !onLayout) throw new Error('Settings list layout callbacks missing');

        await act(async () => {
            onContentSizeChange(0, 1800);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
            onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 1200, height: 400 }));
        });

        expect(scrollTo).toHaveBeenCalledTimes(1);
        expect(scrollTo).toHaveBeenCalledWith({
            y: 1160,
            animated: false,
        });

        await act(async () => {
            onContentSizeChange(0, 1900);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
        });
        expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unknown'],
        [''],
        [['unknown', 'privacy']],
    ])('ignores unsupported or malformed Voice settings focus %j', async (focus) => {
        routeParamsRef.current = { focus };
        const screen = await renderVoiceSettings("privacy");
        const list = screen.tree.root.findByType(ItemList);
        const privacySection = screen.findByTestId('settings.voice.section.privacy');
        const { onContentSizeChange, onLayout } = list.props;
        if (!onContentSizeChange || !onLayout) throw new Error('Settings list layout callbacks missing');

        await act(async () => {
            onContentSizeChange(0, 1800);
            privacySection?.props.onLayout({
                nativeEvent: { layout: { y: 1200, height: 320 } },
            });
            onLayout(createLayoutChangeEvent({ x: 0, y: 0, width: 1200, height: 400 }));
        });

        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('renders local conversation settings when providerId is padded', async () => {
        voiceState.providerId = ' local_conversation ';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const screen = await renderVoiceSettings("conversations");

        expect(screen.findRowByTitle(t('settingsVoice.pages.conversations.talkToTitle'))).toBeTruthy();
        expect(screen.findRowByTitle(t('settingsVoice.pages.conversations.voiceEngineTitle'))).toBeTruthy();
    });

    it('shows local TTS settings even in direct-to-session conversation mode', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'direct_session';

        const screen = await renderVoiceSettings("conversations");

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.voiceEngineTitle')).toBeTruthy();
        expect(screen.findRowByTitle(t('settingsVoice.local.autoSpeak'))).toBeTruthy();
    });

    it('renders the shared selected-daemon model-pack row for web local-neural TTS', async () => {
        voiceState.providerId = 'local_conversation';
        const local = readLocalConversationVoiceSettings(voiceState);
        voiceState = writeLocalConversationVoiceSettings(voiceState, {
            ...local, conversationMode: 'agent',
            tts: {
                ...local.tts, provider: 'local_neural',
                localNeural: {
                    ...local.tts.localNeural, model: 'kokoro',
                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm', execution: 'device',
                },
            },
        });

        const screen = await renderVoiceSettings("conversations");

        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.daemonInference.execution.title')).toBeTruthy();
        expect(screen.findByTestId('voice-model-row-kokoro-82m-v1.0-onnx-q8-wasm')).toBeTruthy();
        expect(screen.findRowByTitle(t('settingsVoice.local.daemonInference.service.title'))).toBeNull();
        expect(screen.findRowByTitle(t('settingsVoice.local.daemonInference.model.title'))).toBeNull();
    });

    it('uses screen-level popover boundaries for dropdowns', async () => {
        voiceState.providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        voiceState.providers['happier.voice.elevenlabs/realtime-elevenlabs'].config.billingMode = 'byo';

        const screen = await renderVoiceSettings("conversations");
        const dropdowns = screen.findAll((node) => node.type === DropdownMenu);
        expect(dropdowns.length).toBeGreaterThan(0);

        const boundaryRef = dropdowns[0]!.props.popoverBoundaryRef;
        expect(boundaryRef).toBeTruthy();
        expect(typeof boundaryRef).toBe('object');
        expect('current' in boundaryRef).toBe(true);

        for (const dropdown of dropdowns) {
            expect(dropdown.props.popoverBoundaryRef).toBe(boundaryRef);
        }
    });

    it('renders only the selected intent detail on each destination', async () => {
        const dictation = await renderVoiceSettings("dictation");
        expect(dictation.findByTestId('settings.voice.section.dictation')).toBeTruthy();
        expect(dictation.findByTestId('settings.voice.provider.off')).toBeNull();
        standardCleanup();

        const conversations = await renderVoiceSettings("conversations");
        expect(conversations.findByTestId('settings.voice.provider.off')).toBeTruthy();
        expect(conversations.findByTestId('settings.voice.section.dictation')).toBeNull();
        expect(conversations.findRowByTitle(tLoose(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey))).toBeNull();
        standardCleanup();

        const advanced = await renderVoiceSettings("advanced");
        const presence = advanced.findRowByTitle(tLoose(VOICE_ADVANCED_SETTINGS.settings.presenceContainer.titleKey));
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

        const dictation = await renderVoiceSettings("dictation");
        expect(dictation.findByTestId('settings.voice.executionMachine.chip')).toBeTruthy();
        standardCleanup();

        const conversations = await renderVoiceSettings("conversations");
        expect(conversations.findByTestId('settings.voice.executionMachine.chip')).toBeNull();
        standardCleanup();

        voiceState.providerId = 'local_direct';
        const localConversations = await renderVoiceSettings("conversations");
        expect(localConversations.findByTestId('settings.voice.executionMachine.chip')).toBeTruthy();
    });

    it('keeps the selected provider disclosure in Privacy & data and the policy entry last', async () => {
        // This used to also render the Conversations screen and assert the disclosure
        // row was absent there. That assertion could not fail: with the suppression
        // flag forced on, the screen still never renders the selected provider's
        // declarative settings group in this harness, so it stayed green either way.
        // Privacy & data owning the copy is the contract worth asserting, and the
        // provider panels no longer contain a second renderer to guard against.
        const privacy = await renderVoiceSettings("privacy");
        const disclosureId = 'settings.voice.provider.disclosure.happier.voice.elevenlabs%2Frealtime-elevenlabs';
        const disclosureDetails = privacy.findAll((node) => typeof node.props.onExpandedChange === 'function'
            && node.findAll((child) => child.props.testID === `${disclosureId}.details`).length > 0)[0];
        expect(disclosureDetails).toBeTruthy();
        await act(async () => disclosureDetails!.props.onExpandedChange(true));
        const disclosure = findItemByTestId(privacy, `${disclosureId}.full`);
        const policy = findItemByTestId(privacy, 'settings.voice.privacyPolicy');
        expect(disclosure).toBeTruthy();
        expect(policy).toBeTruthy();
        expect(String(disclosure?.props.subtitle)).toContain(
            'Audio and conversation content are sent from this device to ElevenLabs',
        );

        const itemRows = privacy.findAll((node) => typeof node.props.title === 'string'
            && typeof node.props.testID === 'string');
        expect(itemRows[itemRows.length - 1]?.props.testID).toBe('settings.voice.privacyPolicy');
        expect(itemRows.indexOf(disclosure!)).toBeLessThan(itemRows.indexOf(policy!));
    });

    it('persists the other local conversation mode with a single tap', async () => {
        await import('@/modal');

        // Enable local conversation so the section renders.
        voiceState.providerId = 'local_conversation';

        const screen = await renderVoiceSettings("conversations");
        // Two short, always-visible options: choosing one is a single tap on a segmented row.
        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.talkToTitle');

        await expect.poll(() => readLocalConversationVoiceSettings(account!.persistedSettings.voice).conversationMode).toBe('agent');
    });

    it('does not use confirm modals for other local conversation enum settings', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const screen = await renderVoiceSettings("conversations");
        await openAdvancedAgent(screen);

        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.itMayTitle');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.local.mediatorCommitModelSource');
        await chooseOtherSegmentedOption(screen, 'settingsVoice.pages.conversations.repliesTitle');

        expect(screen.findAllHostsByTestId('web-modal-confirm')).toHaveLength(0);
    });

    it('disables provider resume when the selected fixed agent does not support vendor resume', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.agentSource = 'agent';
        voiceState.providers.local_conversation.config.agent.agentId = 'unknown-agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent', epoch: 1 };

        const screen = await renderVoiceSettings("privacy");
        const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
        expect(restore).toBeTruthy();
        const providerResume = restore!.props.options.find((option: { id: string }) => option.id === 'provider_resume');
        expect(providerResume?.unavailableReason).toBeTruthy();
    });

    it('can toggle voice agent commit isolation', async () => {
        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.commitIsolation = false;

        const screen = await renderVoiceSettings("conversations");
        await openAdvancedAgent(screen);
        expect(screen.findRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'))).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle(t('settingsVoice.local.conversation.commitIsolation.title'));
        });

        await expect.poll(() => readLocalConversationVoiceSettings(account!.persistedSettings.voice).agent.commitIsolation).toBe(true);
    });

    it('can reset persistent local voice agent memory without changing Account preferences', async () => {
        await import('@/modal');
        const { readPersistentVoiceTranscriptEpoch } = await import('@/voice/persistence/voiceTranscriptMemory');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';
        voiceState.providers.local_conversation.config.agent.transcript = { persistenceMode: 'persistent' };

        const screen = await renderVoiceSettings("privacy");
        const initialSettings = account!.persistedSettings;
        const forget = screen.findRowByTitle(t('settingsVoice.pages.privacy.forgetTitle'))?.props.rightElement;
        expect(forget?.props.testID).toBe('settings.voice.memory.forget');

        await act(async () => {
            forget!.props.onPress();
        });
        await act(async () => {});

        await expect.poll(() => screen.findHostByTestId('web-modal-confirm')).toBeTruthy();
        expect(await readPersistentVoiceTranscriptEpoch()).toBe(0);
        await screen.pressByTestIdAsync('web-modal-confirm');
        await expect.poll(() => readPersistentVoiceTranscriptEpoch()).toBe(1);
        expect(account!.persistedSettings).toEqual(initialSettings);
        expect(readLocalConversationVoiceSettings(account!.persistedSettings.voice).agent.transcript.persistenceMode).toBe('persistent');
    });

    it('preserves a valid voice agent idle TTL beyond six hours', async () => {
        await import('@/modal');

        voiceState.providerId = 'local_conversation';
        voiceState.providers.local_conversation.config.conversationMode = 'agent';

        const screen = await renderVoiceSettings("conversations");
        await openAdvancedAgent(screen);
        expect(screen.findRowByTitle(t('settingsVoice.local.mediatorIdleTtl'))).toBeTruthy();

        await commitInlineField(screen, 'settings.voice.local.idleTtlSeconds.field', '999999');

        await expect.poll(() => readLocalConversationVoiceSettings(account!.persistedSettings.voice).agent.idleTtlSeconds).toBe(999999);
    });

    it('persists the local TTS format and keeps the selected direct provider', async () => {
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

        const screen = await renderVoiceSettings("conversations");
        expect(screen.findRowByTitle(t('settingsVoice.local.ttsFormat'))).toBeTruthy();

        await act(async () => {
            await screen.pressRowByTitle(t('settingsVoice.local.ttsFormat'));
        });
        const format = findDropdownByItemTriggerTitle(screen, 'settingsVoice.local.ttsFormat');
        expect(format).toBeTruthy();
        await act(async () => { format!.props.onSelect('wav'); });

        await expect.poll(() => readVoiceProviderSettingsConfig(account!.persistedSettings.voice, providerId)).toMatchObject({ format: 'wav' });
        const written = account!.persistedSettings.voice;
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

        const screen = await renderVoiceSettings("conversations");
        // I speak reads the speech model's own language; Reply in is the reply preference.
        expect(findItemByTestId(screen, 'settings.voice.language.iSpeak')?.props.detail).toBe('fr');
        const replyIn = findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.replyInTitle');
        expect(replyIn?.props.selectedId).toBe('same');

        await act(async () => {
            replyIn!.props.onSelect('en');
        });

        expect(screen.findAllHostsByTestId('web-prompt-input')).toHaveLength(0);
        await expect.poll(() => account!.persistedSettings.voice.assistantLanguage).toBe('en');
        const written = account!.persistedSettings.voice;
        expect(written.assistantLanguage).toBe('en');
        expect(readLocalDirectVoiceSettings(written).stt.localNeural.language).toBe('fr');
        expect(readLocalDirectVoiceSettings(written).stt.provider).toBe('local_neural');
    });

    it('has no Language section while conversations are off', async () => {
        voiceState.providerId = 'off';
        const screen = await renderVoiceSettings("conversations");
        expect(findDropdownByItemTriggerTitle(screen, 'settingsVoice.pages.conversations.replyInTitle')).toBeNull();
    });

});
