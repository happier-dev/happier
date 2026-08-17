import * as React from 'react';
import { Platform, StyleSheet, View, useWindowDimensions, type ViewStyle } from 'react-native';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { resolveAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance/composerKeyboardGeometry';
import {
    useSessionCockpitBottomChromeHeight,
    useSessionCockpitComposerChromeHeight,
} from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { resolvePetCompanionOverlayMetrics } from '@/components/pets/render/petCompanionDisplayMetrics';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import type { VoiceControlAction, VoiceControlId } from '@/components/voice/controls/VoiceControls';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { VoiceOrb, type VoiceOrbLabels } from './VoiceOrb';
import {
    VOICE_ORB_PET_GAP,
    VOICE_ORB_Z_INDEX,
    resolveVoiceOrbRestingBottomInset,
} from './voiceOrbGeometry';

const NO_EXTRA_CONTROLS: readonly VoiceControlAction[] = Object.freeze([]);

const VOICE_ORB_WEB_POSITION = ('fixed' as unknown) as ViewStyle['position'];

/**
 * App-shell mount for the floating Voice orb (§6.3).
 *
 * Unlike the pet, the orb is **not** excluded under Tauri: the pet uses an OS overlay window on
 * desktop and the orb has none, so it must live inside the web view there.
 *
 * Disabled renders **nothing at all** — no orb, and no live region. A feature the user switched off
 * must not keep announcing to a screen reader; the app-shell announcer owns state announcements
 * regardless. Disabled is not "Voice off": Voice keeps running and stays reachable from the sidebar
 * and the composer.
 */
export function VoiceOrbAppShellMount(): React.ReactElement | null {
    const [orbEnabled] = useLocalSettingMutable('voiceOrbEnabled');
    if (!orbEnabled) return null;
    return <VoiceOrbAppShellRuntime />;
}

function VoiceOrbAppShellRuntime(): React.ReactElement | null {
    // §2.5: idle, the orb starts Global. It never reads the route or the focused session — an
    // already-running attempt is mirrored, whatever it is bound to.
    const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    const [expanded, setExpanded] = useLocalSettingMutable('voiceOrbExpanded');
    const insets = useChromeSafeAreaInsets();
    const bottomChromeHeight = useSessionCockpitBottomChromeHeight();
    const composerChromeHeight = useSessionCockpitComposerChromeHeight();
    const dimensions = useWindowDimensions();
    // Passive settled keyboard height — the canonical signal for chrome-clearing layout. The orb is
    // outside the composer's keyboard scaffold (that provider is session-scoped), so it reads the
    // app-level hook the pet's native mount already uses rather than opening a second subscription.
    const keyboardHeight = useKeyboardHeight();
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const selectedPetPackage = useSelectedPetPackage();

    // D4 / §6.6: pet enabled means the in-webview Orb keeps the same sprite-height clearance on
    // every host, including Tauri. This deliberately consumes only the existing pet projection;
    // cross-webview coordinates would create a second layout owner.
    const petOffset = selectedPetPackage.enabled
        ? resolvePetCompanionOverlayMetrics(petsCompanionSizeScale).spriteHeight + VOICE_ORB_PET_GAP
        : 0;

    // §6.4: the tab bar is only half of the bottom chrome. The composer floats above it in the
    // session screen's own reservation, which is why subtracting `bottomChromeHeight` alone parked
    // the orb's hit target on top of Send and the dictation mic.
    const restingBottomInset = resolveVoiceOrbRestingBottomInset({
        safeAreaBottom: insets.bottom,
        bottomChromeHeight,
        composerChromeHeight,
        keyboardHeight,
        petOffset,
    });

    // §2.7: the sheet's ceiling, not its height. The orb measures its own content and renders at
    // `min(desired, available)`; this is the "available" half — and it has to include the keyboard,
    // because a sheet clamped only to the viewport puts End Voice underneath it.
    const availableSheetHeight = resolveAvailablePanelHeight({
        viewportHeight: dimensions.height,
        keyboardHeight,
        safeAreaBottom: insets.bottom,
        reservedHeight: insets.top,
    });

    const statusLabel = t(resolveVoiceSurfaceStatusPresentation(control.surfaceState).labelKey);
    const labels = React.useMemo<VoiceOrbLabels>(() => ({
        orb: `${t('voiceSurface.orbLabel')}. ${statusLabel}.${control.muted ? ` ${t('voiceSurface.a11y.microphoneMuted')}.` : ''}`,
        startHint: t('voiceSurface.orbStartHint'),
        endHint: t('voiceSurface.orbEndHint'),
        expandAction: t('voiceSurface.orbExpand'),
        collapseAction: t('voiceSurface.orbCollapse'),
        startAction: t('voiceAssistant.startVoice'),
        endAction: t('voiceAssistant.endVoice'),
        status: statusLabel,
        caption: control.captionLabel,
        transport: {
            start: t('voiceAssistant.startVoice'),
            end: t('voiceAssistant.endVoice'),
            startHint: t('voiceSurface.orbStartHint'),
            endHint: t('voiceSurface.orbEndHint'),
            startText: t('voiceSurface.start'),
            endText: t('voiceSurface.stop'),
            mute: t('voiceSurface.a11y.mute'),
            unmute: t('voiceSurface.a11y.unmute'),
        },
    }), [control.captionLabel, control.muted, statusLabel]);

    /*
     * §2.5 — a direct/session-bound attempt has a conversation the user came from, and expanding the
     * orb has to offer the way back to *that exact one*.
     *
     * The fact and the dispatch both come from the projection, which reads the canonical binding: a
     * floating companion that resolved its own conversation would be a second opinion about what the
     * running attempt is bound to. A global attempt has no such conversation, so it offers none
     * rather than an action that lands somewhere arbitrary.
     */
    const openConversationSessionId = control.openConversationSessionId;
    const onOpenConversation = control.onOpenConversation;
    const extraControls = React.useMemo<readonly VoiceControlAction[]>(() => (
        openConversationSessionId
            ? [{
                id: 'openConversation',
                label: t('voiceSurface.a11y.openConversation'),
                weight: 'secondary',
            }]
            : NO_EXTRA_CONTROLS
    ), [openConversationSessionId]);
    const handleAction = React.useCallback((id: VoiceControlId) => {
        if (id === 'openConversation') onOpenConversation();
    }, [onOpenConversation]);

    // Terminally unavailable: do not render a transport that cannot do anything.
    if (control.availability === 'unavailable') return null;

    return (
        <View
            pointerEvents="box-none"
            style={Platform.OS === 'web' ? styles.webRoot : styles.nativeRoot}
            testID="voice-orb-app-shell-root"
        >
            <VoiceOrb
                control={control}
                labels={labels}
                expanded={expanded}
                onExpandedChange={setExpanded}
                restingBottomInset={restingBottomInset}
                availableSheetHeight={availableSheetHeight}
                extraControls={extraControls}
                onAction={handleAction}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    webRoot: {
        position: VOICE_ORB_WEB_POSITION,
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
