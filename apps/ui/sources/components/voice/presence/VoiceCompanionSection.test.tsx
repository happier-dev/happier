import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

// Native popovers render in-tree; the section, menu, model and focused-Session owner stay real.
installPopoverCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});

const { getStorage } = await import('@/sync/domains/state/storage');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
const { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
const { setFocusedSessionId } = await import('@/sync/domains/session/sessionSurfaceVisibility');
const { createNearViewportTracker } = await import('@/components/widgets/nearViewport');
const { VoiceCompanionSection } = await import('./VoiceCompanionSection');

const initialStorage = getStorage().getState();
const initialBindings = voiceSessionBindingStore.getState();
let screen: RenderScreenResult | null = null;

afterEach(async () => {
    await screen?.unmount();
    screen = null;
    setFocusedSessionId(null);
    getStorage().setState(initialStorage, true);
    voiceSessionBindingStore.setState(initialBindings, true);
    registerVoiceAdapters([]);
    resetVoiceSessionStoreForTests();
    resetServerFeaturesClientForTests();
});

it('omits opening the conversation from its own Companion menu and restores it after navigating away', async () => {
    resetVoiceSessionStoreForTests();
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
        features: { voice: { enabled: true } }, capabilities: {},
    }) } });
    getStorage().setState(state => ({ settings: {
        ...state.settings,
        experiments: true,
        featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.agent': true },
        voice: voiceSettingsParse({ providerId: 'local_conversation' }),
    } }));
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const conversation = { serverId: 'home-a', sessionId: 'voice-menu-conversation' };
    voiceSessionBindingStore.getState().bind({
        adapterId: 'local_conversation', controlSessionId: 'voice-menu',
        conversationSessionId: conversation.sessionId, conversationSessionAddress: conversation,
        targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1,
    });
    setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-menu', status: 'connected', mode: 'listening', canStop: true });
    const tracker = createNearViewportTracker({ quantum: 44, initialViewportHeight: 768 });
    screen = await renderScreen(<VoiceCompanionSection tracker={tracker} />);
    await act(async () => {
        screen!.findHostByTestId('voice-companion-section-presentation')!.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 240 } },
        });
    });
    await screen.pressByTestIdAsync('voice-companion-section-actions');
    expect(screen.findHostByTestId('voice-settings')).not.toBeNull();
    expect(screen.findHostByTestId('open-conversation')).not.toBeNull();

    await act(async () => { setFocusedSessionId(conversation.sessionId, conversation.serverId); });
    expect(screen.findHostByTestId('open-conversation')).toBeNull();
    expect(screen.findHostByTestId('voice-settings')).not.toBeNull();

    // Session ids are scoped to their Home: the same id elsewhere is still a destination.
    await act(async () => { setFocusedSessionId(conversation.sessionId, 'home-b'); });
    expect(screen.findHostByTestId('open-conversation')).not.toBeNull();
    await act(async () => { setFocusedSessionId(null); });
    expect(screen.findHostByTestId('open-conversation')).not.toBeNull();
});
