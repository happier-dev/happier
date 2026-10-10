import * as React from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import {
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitComposerChromeHeight,
    useReportSessionCockpitFloatingBottomChromeHeight,
    useSessionCockpitViewerRect,
    useSessionCockpitPetRect,
    useReportSessionCockpitVoicePresenceRect,
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
import { revealVoiceCompanionSection } from './voiceCompanionSectionReveal';
import { useVoicePresenceContainer } from './useVoicePresenceContainer';
import { resolveVoiceOrbInteractionPadding } from './voicePresenceAnatomy';
import {
    VOICE_ORB_PET_GAP,
    VOICE_ORB_Z_INDEX,
    resolveVoiceOrbRestingBottomInset,
} from './voicePresenceGeometry';

const WEB_FIXED = ('fixed' as unknown) as ViewStyle['position'];
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
    if (voiceEnabled !== true || container === 'top_bar') return null;
    // Measurement custody follows the container; admitted Voice state outlives its presentation.
    return <VoiceFloatingPresenceRuntime key={container} container={container} />;
}

function VoiceFloatingPresenceRuntime(props: Readonly<{ container: 'island' | 'orb' }>): React.ReactElement | null {
    // Idle starts honor the shared scope preference; a running attempt retains its admitted binding.
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_DEFAULT);
    const phone = useDeviceType() === 'phone';
    const insets = useChromeSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const composerChromeHeight = useSessionCockpitComposerChromeHeight();
    const keyboardHeight = useKeyboardHeight();
    const viewport = useWindowDimensions();
    const viewerRect = useSessionCockpitViewerRect();
    const petRect = useSessionCockpitPetRect();
    const avoidRects = React.useMemo(() => petRect ? [petRect] : undefined, [petRect]);
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const selectedPetPackage = useSelectedPetPackage();
    const anchorRef = React.useRef<View | null>(null);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    // A container's caption shows the Voice section in the Companion when it is beside the work,
    // otherwise as a popover anchored to the container.
    const toggleSection = React.useCallback(() => {
        if (open) {
            setOpen(false);
            return;
        }
        if (!revealVoiceCompanionSection()) setOpen(true);
    }, [open]);

    const orb = props.container === 'orb';
    // One visibility fact governs both the container and its measured composer clearance.
    // Keyboard-open moves the same presence above measured keyboard chrome; transport stays reachable.
    const visible = voice.availability !== 'unavailable'
        && (orb || voice.live || Boolean(voice.ended));
    // The keyboard scaffold already lifts the composer. In that state the float clears the
    // measured composer instead of reporting the keyboard height back as composer reservation.
    const reservesComposerSpace = visible && phone && !orb && keyboardHeight === 0;
    const reportBottomReservation = useReportSessionCockpitFloatingBottomChromeHeight(reservesComposerSpace);
    const reportPresenceRect = useReportSessionCockpitVoicePresenceRect(visible);
    if (!visible) return null;

    // Desktop mascot windows retain their incumbent band. In-app pets publish their actual
    // moved rectangle instead of reserving a second, assumed corner alongside that measurement.
    const petOffset = orb && isDesktopHost() && selectedPetPackage.enabled
        ? resolvePetCompanionOverlayMetrics(petsCompanionSizeScale).spriteHeight + VOICE_ORB_PET_GAP
        : 0;
    const restingBottomInset = resolveVoiceOrbRestingBottomInset({
        safeAreaBottom: insets.bottom,
        bottomChromeHeight,
        composerChromeHeight: reservesComposerSpace ? 0 : composerChromeHeight,
        keyboardHeight,
        petOffset,
    });
    const width = orb
        ? VOICE_ORB_BODY_SIZE
        : phone ? Math.max(0, viewport.width - ISLAND_EDGE * 2) : VOICE_ISLAND_DESKTOP.width;
    const height = orb ? VOICE_ORB_BODY_SIZE : phone ? VOICE_ISLAND_PHONE.height : VOICE_ISLAND_DESKTOP.height;
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
                minimumTop={FLOAT_MIN_TOP + insets.top}
                interactionPaddingHorizontal={orb ? resolveVoiceOrbInteractionPadding(Platform.OS, voice.live || Boolean(voice.ended)) : 0}
                restCentred={!orb && phone}
                anchors={orb ? 'orb' : 'island'}
                bottomChromeInset={insets.bottom + bottomChromeHeight}
                onBottomReservationChange={reservesComposerSpace ? reportBottomReservation : undefined}
                viewerRect={viewerRect}
                avoidRects={avoidRects}
                onRectChange={reportPresenceRect}
            >
                {(render) => orb ? (
                    <VoiceOrb
                        voice={voice}
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
                        phone={phone}
                        width={width}
                        anchorRef={anchorRef}
                        sectionOpen={open}
                        onOpenSection={toggleSection}
                        shouldSuppressPress={render.shouldSuppressPress}
                    />
                )}
            </VoicePresenceFloat>
            <VoiceGlancePopover open={open && (voice.live || Boolean(voice.ended))} anchorRef={anchorRef} placement="top" onRequestClose={close} />
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
});
