/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitComposerBottomChromeHeight,
    useReportSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { VoicePresenceAppShellMount } from './VoicePresenceAppShellMount';
import { VoiceTopBarPresenceMount } from './VoiceTopBarPresence';
import { SessionCompanionContent } from '@/components/sessions/companion/SessionCompanionContent';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';

const keyboard = vi.hoisted(() => ({ height: 0 }));
// Settled OS keyboard geometry is the environment boundary.
vi.mock('@/hooks/ui/useKeyboardHeight', () => ({ useKeyboardHeight: () => keyboard.height }));

// The platform's dimensions are the external boundary; feature policy, attempt projection,
// settings, ended-attempt lifecycle and shell geometry all remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) },
    });
});

const initialStorage = getStorage().getState();

function ComposerClearance() {
    const setBar = useSessionCockpitBottomChromeHeightSetter();
    const height = useSessionCockpitComposerBottomChromeHeight();
    React.useEffect(() => { setBar(62); }, [setBar]);
    return <View testID="composer-clearance" accessibilityValue={{ now: height }} />;
}

async function layOutPhonePresence(screen: Awaited<ReturnType<typeof renderScreen>>) {
    expect(screen.findHostByTestId('voice-presence-app-shell-root')).not.toBeNull();
    await act(async () => { screen.findByTestId('voice-presence-float-host')!.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); });
    const frame = screen.findByTestId('voice-presence-float-body')!.props.style[0];
    await act(async () => { screen.findByTestId('voice-presence-float-body')!.props.onLayout({ nativeEvent: { layout: { width: frame.width, height: frame.height } } }); });
}

function MeasuredComposer() {
    const report = useReportSessionCockpitComposerChromeHeight(true);
    React.useEffect(() => { report(62); }, [report]);
    return null;
}

describe('phone Island shell clearance', () => {
    beforeEach(() => {
        keyboard.height = 0;
        resetVoiceSessionStoreForTests();
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: {
            status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }),
        } });
        getStorage().setState((state) => ({
            settings: { ...state.settings, experiments: true,
                featureToggles: { ...state.settings.featureToggles, voice: true },
                voice: voiceSettingsParse({ providerId: 'local_conversation', providers: {
                    local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
                } }),
            },
            localSettings: { ...state.localSettings, voicePresenceContainer: 'island' },
        }));
        registerVoiceAdapters([{
            id: 'local_conversation', engineKind: 'realtime',
            start: async () => {}, stop: async () => {}, toggle: async () => {},
            interrupt: async () => {}, bargeIn: async () => {}, setMuted: async () => {},
            sendContextUpdate: () => {},
            getSnapshot: () => ({ adapterId: 'local_conversation', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }),
            resolveSurfaceCapabilities: () => ({ allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false, bargeInEnabled: false }),
        }]);
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-shell', status: 'connected', mode: 'listening', canStop: true });
    });
    it('resolves a stored phone Top bar to one Island without rewriting the local choice', async () => {
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: 'top_bar' } }));
        const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><MeasuredComposer /><VoicePresenceAppShellMount /></SessionCockpitChromeRegistryProvider>);
        try {
            await layOutPhonePresence(screen);
            expect(screen.findByTestId('voice-island-body')).not.toBeNull();
            expect(screen.findAllHostsByTestId('voice-presence-app-shell-root')).toHaveLength(1);
            expect(getStorage().getState().localSettings.voicePresenceContainer).toBe('top_bar');
        } finally { await screen.unmount(); }
    });

    it.each(['island', 'orb'] as const)('retains %s options and bound transport with the phone keyboard open', async (container) => {
        keyboard.height = 300;
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: container } }));
        const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><MeasuredComposer /><VoicePresenceAppShellMount /></SessionCockpitChromeRegistryProvider>);
        try {
            await layOutPhonePresence(screen);
            expect(screen.findByTestId(container === 'island' ? 'voice-island-body' : 'voice-orb-options')).not.toBeNull();
            const float = screen.findByTestId('voice-presence-float-body')!.props.style;
            const y = float[float.length - 1].transform.find((entry: { translateY?: number }) => entry.translateY !== undefined).translateY;
            expect(y + float[0].height).toBeLessThanOrEqual(844 - keyboard.height - 62);
            await act(async () => { setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-shell', status: 'connected', mode: 'listening', canStop: true, micMuted: true }); });
            expect(screen.findByTestId(container === 'island' ? 'voice-island-transport-mute' : 'voice-orb-options')).not.toBeNull();
            await act(async () => { setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-shell', status: 'connected', mode: 'idle', canStop: true, presentationState: 'reconnecting', reconnectRetryAvailable: true }); });
            expect(screen.findByTestId(container === 'island' ? 'voice-island-transport-recover' : 'voice-orb-options')).not.toBeNull();
        } finally { await screen.unmount(); }
    });
    afterEach(() => {
        getStorage().setState(initialStorage, true);
        registerVoiceAdapters([]);
        resetVoiceSessionStoreForTests();
        resetServerFeaturesClientForTests();
    });

    it('reveals an offscreen Voice section through the Companion scroll owner without opening a second glance', async () => {
        // ScrollView is an OS/browser boundary; controller, section, presentation tracker and glance stay real.
        let scrollY = 600;
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        const scrollTo = vi.fn(({ y }: { y: number }) => {
            scrollY = y;
            screen?.findByTestId('companion-scroll')?.props.onScroll({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height: 400 } } });
        });
        const session = createSessionFixture({ id: 'voice-shell' });
        const openFullSurface = () => {};
        function Scene() {
            const controller = useSessionCompanionController({ sessionId: session.id, serverId: 'server-a', openFullSurface });
            return <><VoiceTopBarPresenceMount /><SessionCompanionContent session={session} controller={controller}
                boardBinding={null} resolvePrimaryHost={() => null} testID="companion-scroll" /></>;
        }
        // Render the actual pill independently of phone placement for this scroll-contract slice.
        const { VoiceTopBarPresence } = await import('./VoiceTopBarPresence');
        const { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } = await import('../attempt/useVoiceAttemptControl');
        function Pill() { return <VoiceTopBarPresence voice={useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL)} />; }
        screen = await renderScreen(<><Pill /><Scene /></>, { createNodeMock: (element) => {
            const props = element.props;
            return typeof props === 'object' && props !== null && 'testID' in props && props.testID === 'companion-scroll'
                ? { scrollTo } : null;
        } });
        try {
            await act(async () => {
                screen!.findByTestId('companion-scroll')!.props.onLayout({ nativeEvent: { layout: { height: 400 } } });
                screen!.findByTestId('companion-scroll-voice-presentation')!.props.onLayout({ nativeEvent: { layout: { y: 2, height: 180 } } });
                screen!.findByTestId('companion-scroll')!.props.onScroll({ nativeEvent: { contentOffset: { y: scrollY }, layoutMeasurement: { height: 400 } } });
            });
            await screen.pressByTestIdAsync('voice-top-bar-label');
            expect(scrollY).toBe(0);
            expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
            expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(false);
            expect(screen.findByTestId('companion-scroll-voice-glance-mute')).not.toBeNull();
        } finally { await screen.unmount(); }
    });

    it('retains measured clearance while the ended Island remains visible and withdraws it on container removal', async () => {
        const scene = (visible: boolean) => <SessionCockpitChromeRegistryProvider>
            <ComposerClearance />
            {visible ? <VoicePresenceAppShellMount /> : null}
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(true));
        try {
            await act(async () => { screen.findByTestId('voice-presence-float-host')!.props.onLayout({ nativeEvent: { layout: { width: 390, height: 844 } } }); });
            await act(async () => { screen.findByTestId('voice-presence-float-body')!.props.onLayout({ nativeEvent: { layout: { width: 358, height: 70 } } }); });
            expect(screen.findByTestId('composer-clearance')!.props.accessibilityValue.now).toBe(144);
            await act(async () => { setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false }); });
            expect(screen.findByTestId('voice-presence-float-body')).not.toBeNull();
            expect(screen.findByTestId('composer-clearance')!.props.accessibilityValue.now).toBe(144);
            await screen.update(scene(false));
            expect(screen.findByTestId('composer-clearance')!.props.accessibilityValue.now).toBe(62);
        } finally { await screen.unmount(); }
    });
});
