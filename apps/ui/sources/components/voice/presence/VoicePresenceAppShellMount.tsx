import * as React from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import {
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitComposerChromeHeight,
    useSessionCockpitComposerChromeTop,
    useSessionCockpitComposerChromeRightInset,
    useReportSessionCockpitFloatingBottomChromeHeight,
    useReportSessionCockpitTranscriptBottomClearance,
    useSessionCockpitPetRect,
    useSessionCockpitActionRailRect,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_DEFAULT,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { isDesktopHost } from '@/utils/platform/desktopHost';

import { VoiceGlancePopover } from './VoiceGlancePopover';
import { VoiceIsland, VOICE_ISLAND_DESKTOP, VOICE_ISLAND_PHONE } from './VoiceIsland';
import { VoiceOrb, VOICE_ORB_BODY_SIZE } from './VoiceOrb';
import { VoicePresenceFloat } from './VoicePresenceFloat';
import { useVoiceReadAloud, type VoiceReadAloud } from './VoiceReadAloud';
import {
    isVoiceCompanionSectionOnScreen,
    registerVoiceGlancePresentation,
    revealVoiceCompanionSection,
    subscribeVoiceCompanionSectionOnScreen,
} from './voiceCompanionSectionReveal';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useVoicePresenceContainer } from './useVoicePresenceContainer';
import { resolveVoicePresenceReadAloud } from './resolveVoicePresenceReadAloud';
import { resolveVoiceOrbInteractionPadding } from './voicePresenceAnatomy';
import {
    VOICE_ORB_PET_GAP,
    VOICE_ORB_Z_INDEX,
    resolveVoiceOrbRestingBottomInset,
    resolveVoicePresenceContentBottom,
} from './voicePresenceGeometry';

const WEB_FIXED = ('fixed' as unknown) as ViewStyle['position'];
const executePresentationAction = createFrontDoorUiActionExecutor();
/** The floating containers' gutter from the window edges (lab I: 16; lab O: 14). */
const ISLAND_EDGE = 16;
const ORB_EDGE = 14;
/** They never climb into the title strip / status bar band. */
const FLOAT_MIN_TOP = 56;

/**
 * The app shell's one floating Voice presence (§4.3): the Island or the Orb, whichever this device
 * chose (`voicePresenceContainer`). Top bar mode floats nothing — its container lives in the title
 * strip — and the Companion section and the composer mark are persistent consumers in every mode,
 * never a second floating presence.
 */
export function VoicePresenceAppShellMount(): React.ReactElement | null {
    const voiceEnabled = useFeatureEnabled('voice');
    const container = useVoicePresenceContainer();
    const readAloud = useVoiceReadAloud();
    if ((voiceEnabled !== true && readAloud.phase === 'idle') || container === 'top_bar') return null;
    // Measurement custody follows the container; admitted Voice state outlives its presentation.
    return <VoiceFloatingPresenceRuntime key={container} container={container} readAloud={readAloud} />;
}

function VoiceFloatingPresenceRuntime(props: Readonly<{ container: 'island' | 'orb'; readAloud: VoiceReadAloud }>): React.ReactElement | null {
    // Idle starts honor the shared scope preference; a running attempt retains its admitted binding.
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_DEFAULT);
    const readAloud = props.readAloud;
    const phone = useDeviceType() === 'phone';
    // Keep glance intent when the Companion temporarily suppresses this float.
    const [open, setOpen] = React.useState(false);
    const orb = props.container === 'orb';
    // While the Companion's Voice section is on screen it is the call's one glance: the floating
    // presence steps back instead of resting over the Companion column (on a phone the Orb stays).
    const sectionOnScreen = React.useSyncExternalStore(
        subscribeVoiceCompanionSectionOnScreen, isVoiceCompanionSectionOnScreen, isVoiceCompanionSectionOnScreen);
    const yieldsToSection = sectionOnScreen && !(phone && orb);
    // One visibility fact governs both the container and its measured composer clearance.
    // Keyboard-open moves the same presence above measured keyboard chrome; transport stays reachable.
    // A reading stays presented with its Stop whatever the call can do next.
    const visible = !yieldsToSection && (resolveVoicePresenceReadAloud(voice, readAloud) !== null
        || (voice.availability !== 'unavailable' && (orb || voice.live || Boolean(voice.ended))));
    React.useLayoutEffect(() => visible ? registerVoiceGlancePresentation((expanded) => {
        if (!expanded || !revealVoiceCompanionSection()) setOpen(expanded);
    }) : undefined, [visible]);
    if (!visible) return null;
    return <VoiceVisibleFloatingPresence {...props} voice={voice} phone={phone} open={open} />;
}

/** Geometry and pet readers exist only for a presented float. */
function VoiceVisibleFloatingPresence(props: Readonly<{
    container: 'island' | 'orb';
    readAloud: VoiceReadAloud;
    voice: ReturnType<typeof useVoiceAttemptControl>;
    phone: boolean;
    open: boolean;
}>): React.ReactElement {
    const { voice, readAloud, phone, open } = props;
    const orb = props.container === 'orb';
    const insets = useChromeSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const composerChromeHeight = useSessionCockpitComposerChromeHeight();
    const composerChromeTop = useSessionCockpitComposerChromeTop();
    // The float belongs to the session column: it rests where the composer ends, so a pane docked
    // beside the column (Info, Files) moves it instead of being covered by it.
    const columnRightInset = useSessionCockpitComposerChromeRightInset();
    const keyboardHeight = useKeyboardHeight();
    const viewport = useWindowDimensions();
    const petRect = useSessionCockpitPetRect();
    const actionRailRect = useSessionCockpitActionRailRect();
    // The Orb rests clear of the pet and of the session's right tool rail.
    const avoidRects = React.useMemo(() => {
        const rects = [petRect, actionRailRect].filter((rect): rect is NonNullable<typeof rect> => rect !== null);
        return rects.length > 0 ? rects : undefined;
    }, [actionRailRect, petRect]);
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const selectedPetPackage = useSelectedPetPackage();
    const anchorRef = React.useRef<View | null>(null);
    const close = React.useCallback(() => {
        fireAndForget(executePresentationAction('ui.voice_global.glance.close', {}), { tag: 'VoicePresence.glance.close' });
    }, []);
    // A container's caption shows the Voice section in the Companion when it is beside the work,
    // otherwise as a popover anchored to the container.
    const toggleSection = React.useCallback(() => {
        fireAndForget(executePresentationAction(open ? 'ui.voice_global.glance.close' : 'ui.voice_global.glance.open', {}),
            { tag: 'VoicePresence.glance' });
    }, [open]);

    // The keyboard scaffold already lifts the composer. In that state the float clears the
    // measured composer instead of reporting the keyboard height back as composer reservation.
    const reservesComposerSpace = phone && !orb && keyboardHeight === 0;
    const reportBottomReservation = useReportSessionCockpitFloatingBottomChromeHeight(reservesComposerSpace);
    // Resting above the composer instead, it covers the transcript's last rows: the transcript keeps
    // that much space after its last row (the composer stays where it is).
    const reportTranscriptClearance = useReportSessionCockpitTranscriptBottomClearance(!reservesComposerSpace);

    // Desktop mascot windows retain their incumbent band. In-app pets publish their actual
    // moved rectangle instead of reserving a second, assumed corner alongside that measurement.
    const petOffset = orb && isDesktopHost() && selectedPetPackage.enabled
        ? resolvePetCompanionOverlayMetrics(petsCompanionSizeScale).spriteHeight + VOICE_ORB_PET_GAP
        : 0;
    const restingChrome = {
        safeAreaBottom: insets.bottom,
        bottomChromeHeight,
        // A phone Island docked under the composer lifts it by its own reservation instead.
        composerChromeHeight: reservesComposerSpace ? 0 : composerChromeHeight,
        composerTopFromBottom: reservesComposerSpace ? 0 : composerChromeTop,
        keyboardHeight,
        petOffset,
    };
    const restingBottomInset = resolveVoiceOrbRestingBottomInset(restingChrome);
    const width = orb
        ? VOICE_ORB_BODY_SIZE
        : phone ? Math.max(0, viewport.width - ISLAND_EDGE * 2) : VOICE_ISLAND_DESKTOP.width;
    const height = orb ? VOICE_ORB_BODY_SIZE : phone ? VOICE_ISLAND_PHONE.height : VOICE_ISLAND_DESKTOP.height;
    // The open glance takes the container's place (lab: the glance replaces the capsule), so the call's
    // state and any request show once. The container stays mounted: the glance anchors to it and
    // returns focus there when it closes.
    const glanceShown = open && (voice.live || Boolean(voice.ended));
    return (
        <View
            pointerEvents="box-none"
            style={Platform.OS === 'web' ? styles.webRoot : styles.nativeRoot}
            testID="voice-presence-app-shell-root"
        >
            <VoicePresenceFloat
                testID="voice-presence-float-host"
                width={width}
                height={height}
                restingBottomInset={restingBottomInset}
                edgeInset={orb ? ORB_EDGE : ISLAND_EDGE}
                columnRightInset={columnRightInset}
                minimumTop={FLOAT_MIN_TOP + insets.top}
                interactionPaddingHorizontal={orb ? resolveVoiceOrbInteractionPadding(Platform.OS, voice.live || Boolean(voice.ended) || readAloud.phase !== 'idle') : 0}
                restCentred={!orb && phone}
                anchors={orb ? 'orb' : 'island'}
                // Docked under the composer, what the float adds above the bar lifts the composer; resting
                // above it, what the float covers above the content's bottom edge clears the transcript.
                bottomChromeInset={reservesComposerSpace
                    ? insets.bottom + bottomChromeHeight
                    : resolveVoicePresenceContentBottom(restingChrome)}
                onBottomReservationChange={reservesComposerSpace ? reportBottomReservation : reportTranscriptClearance}
                avoidRects={avoidRects}
            >
                {(render) => (
                    <View
                        testID="voice-presence-capsule"
                        pointerEvents={glanceShown ? 'none' : 'box-none'}
                        aria-hidden={glanceShown}
                        style={glanceShown ? styles.yielded : undefined}
                    >
                    {orb ? (
                    <VoiceOrb
                        voice={voice}
                        readAloud={readAloud}
                        anchorRef={anchorRef}
                        sectionOpen={open}
                        onOpenSection={toggleSection}
                        shouldSuppressPress={render.shouldSuppressPress}
                        translateX={render.translateX}
                        hostWidth={render.hostWidth}
                    />
                ) : (
                    <VoiceIsland
                        voice={voice}
                        readAloud={readAloud}
                        phone={phone}
                        width={width}
                        anchorRef={anchorRef}
                        sectionOpen={open}
                        onOpenSection={toggleSection}
                        shouldSuppressPress={render.shouldSuppressPress}
                    />
                    )}
                    </View>
                )}
            </VoicePresenceFloat>
            {/* Pinned to the container's bottom edge: the glance stands where the container was. */}
            <VoiceGlancePopover open={glanceShown} anchorRef={anchorRef} placement="top" gap={-height} onRequestClose={close} />
        </View>
    );
}

const styles = StyleSheet.create({
    webRoot: {
        position: WEB_FIXED,
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        backgroundColor: 'transparent',
        zIndex: VOICE_ORB_Z_INDEX,
    },
    nativeRoot: {
        ...StyleSheet.absoluteFillObject,
        zIndex: VOICE_ORB_Z_INDEX,
    },
    yielded: { opacity: 0 },
});
