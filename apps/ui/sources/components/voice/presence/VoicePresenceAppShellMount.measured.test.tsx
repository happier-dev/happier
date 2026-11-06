/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { getStorage } from '@/sync/domains/state/storage';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import {
    SessionCockpitChromeRegistryProvider,
    useSessionCockpitBottomChromeHeightSetter,
    useSessionCockpitComposerBottomChromeHeight,
    useReportSessionCockpitComposerChromeHeight,
    useReportSessionCockpitActionRailRect,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { VoicePresenceAppShellMount } from './VoicePresenceAppShellMount';
import { VOICE_ORB_BODY_SIZE } from './voicePresenceAnatomy';
import { VoiceTopBarPresenceMount } from './VoiceTopBarPresence';
import { VoiceTopBarPresence } from './VoiceTopBarPresence';
import { SessionCompanionContent } from '@/components/sessions/companion/SessionCompanionContent';
import { useSessionCompanionController } from '@/components/sessions/companion/state/useSessionCompanionController';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } from '../attempt/useVoiceAttemptControl';

const keyboard = vi.hoisted(() => ({ height: 0 }));
const viewport = vi.hoisted(() => ({ width: 390, height: 844, scale: 1, fontScale: 1 }));
const initialInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
const initialVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
const initialTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
let focusedInput: HTMLInputElement | null = null;

// The browser viewport and editable focus are the external inputs; the real
// keyboard hook and inset projector decide what the shell must clear.
function installViewportBoundary(): void {
    const events = new window.EventTarget();
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => viewport.height });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: {
        get width() { return viewport.width; },
        get height() { return viewport.height - keyboard.height; },
        offsetTop: 0,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
    } });
    focusedInput = document.createElement('input');
    document.body.append(focusedInput);
    focusedInput.focus();
}

// The platform's dimensions are the external boundary; feature policy, attempt projection,
// settings, ended-attempt lifecycle and shell geometry all remain real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: { get: () => ({ ...viewport }) },
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

/** The desktop composer band: 208 tall, lifted 41 px off the window edge by the workspace frame. */
function FramedDesktopComposer() {
    const report = useReportSessionCockpitComposerChromeHeight(true);
    React.useEffect(() => { report(208, 900 - 651); }, [report]);
    return null;
}

function ActionRailObstacle(props: Readonly<{ rect: FrameRect | null }>) {
    const report = useReportSessionCockpitActionRailRect(props.rect !== null);
    React.useEffect(() => { report(props.rect); }, [props.rect, report]);
    return null;
}

/** The orb's resting x, as the float hands it to the mark (the viewport's own coordinates). */
function orbX(screen: Awaited<ReturnType<typeof renderScreen>>): number {
    return screen.root.findAll((node) => node.props.sectionOpen !== undefined && node.props.translateX !== undefined)[0]!.props.translateX.get();
}

describe('phone Island shell clearance', () => {
    beforeEach(() => {
        keyboard.height = 0;
        installViewportBoundary();
        resetVoiceSessionStoreForTests();
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({ snapshot: {
            status: 'ready',
            features: FeaturesResponseSchema.parse({ features: { voice: { enabled: true } }, capabilities: {} }),
        } });
        getStorage().setState((state) => ({
            settings: { ...state.settings, experiments: true,
                featureToggles: { ...state.settings.featureToggles, voice: true, 'voice.agent': true, 'execution.runs': true },
                voice: voiceSettingsParse({ providerId: 'local_conversation', providers: {
                    local_conversation: { schemaVersion: 1, config: { conversationMode: 'agent' } },
                } }),
            },
            localSettings: { ...state.localSettings, voicePresenceContainer: 'island' },
        }));
        registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
        setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'voice-shell', status: 'connected', mode: 'listening', canStop: true });
    });
    it('keeps the Orb off the pane action rail at the window edge and returns to the edge when the rail goes', async () => {
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: 'orb' } }));
        // The session's right tool rail: a full-height strip against the right edge, where the Orb rests.
        const rail = { x: 346, y: 90, width: 44, height: 700 };
        const scene = (rect: FrameRect | null) => <SessionCockpitChromeRegistryProvider>
            <ActionRailObstacle rect={rect} /><VoicePresenceAppShellMount />
        </SessionCockpitChromeRegistryProvider>;
        const screen = await renderScreen(scene(rail));
        try {
            await layOutPhonePresence(screen);
            expect(orbX(screen) + VOICE_ORB_BODY_SIZE).toBeLessThanOrEqual(rail.x);
            const clear = orbX(screen);
            await screen.update(scene(null));
            await layOutPhonePresence(screen);
            expect(orbX(screen)).toBeGreaterThan(clear);
        } finally { await screen.unmount(); }
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
    it.each(['island', 'orb'] as const)('rests the desktop %s above a composer the workspace frame lifts off the window edge', async (container) => {
        viewport.width = 1440;
        viewport.height = 900;
        getStorage().setState((state) => ({ localSettings: { ...state.localSettings, voicePresenceContainer: container } }));
        const screen = await renderScreen(<SessionCockpitChromeRegistryProvider><FramedDesktopComposer /><VoicePresenceAppShellMount /></SessionCockpitChromeRegistryProvider>);
        try {
            expect(screen.findHostByTestId('voice-presence-app-shell-root')).not.toBeNull();
            await act(async () => { screen.findByTestId('voice-presence-float-host')!.props.onLayout({ nativeEvent: { layout: { width: 1440, height: 900 } } }); });
            const frame = screen.findByTestId('voice-presence-float-body')!.props.style[0];
            await act(async () => { screen.findByTestId('voice-presence-float-body')!.props.onLayout({ nativeEvent: { layout: { width: frame.width, height: frame.height } } }); });
            const float = screen.findByTestId('voice-presence-float-body')!.props.style;
            const y = float[float.length - 1].transform.find((entry: { translateY?: number }) => entry.translateY !== undefined).translateY;
            // The composer band starts at y 651 (its meters at 665): the float rests above it.
            expect(y + float[0].height).toBeLessThanOrEqual(651);
        } finally { await screen.unmount(); }
    });

    afterEach(() => {
        focusedInput?.remove();
        focusedInput = null;
        if (initialInnerHeight) Object.defineProperty(window, 'innerHeight', initialInnerHeight);
        if (initialVisualViewport) Object.defineProperty(window, 'visualViewport', initialVisualViewport);
        else Reflect.deleteProperty(window, 'visualViewport');
        if (initialTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', initialTouchPoints);
        else Reflect.deleteProperty(navigator, 'maxTouchPoints');
        viewport.width = 390;
        viewport.height = 844;
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
            const { setVoiceGlanceOpen } = await import('./voiceCompanionSectionReveal');
            await act(async () => { setVoiceGlanceOpen(true); });
            expect(scrollY).toBe(0);
            expect(scrollTo).toHaveBeenCalledWith({ y: 0, animated: false });
            expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(false);
            expect(screen.findByTestId('companion-scroll-voice-glance-transport-mute')).not.toBeNull();
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
