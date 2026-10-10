import * as React from 'react';

import {
    useVoiceAttemptControl,
    type VoiceAttemptIdleTarget,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceEnergyIfMounted } from '@/components/voice/light/useVoiceEnergy';
import { resolveVoiceMarkPose } from '@/components/voice/presence/resolveVoiceMarkPose';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { useHostActivelyFocused } from '@/utils/runtime/useHostActivelyViewed';

import { VoiceComposerPlanet } from './VoiceComposerPlanet';

/**
 * The composer planet, wired to the one canonical Voice attempt (§2.3, §2.5).
 *
 * The leaf below is deliberately model-free — every fact it draws is a primitive
 * prop — so this is where the subscription lives. Keeping it here rather than in
 * `AgentInput` is what stops a 3k-line composer from re-rendering on every Voice
 * mode change: only this component re-renders, and the planet is `React.memo` over
 * primitives beneath it (§16.2).
 *
 * **Targeting is stated here, not inferred by the projection.** The composer of an
 * existing session starts *that* conversation; the New Session composer has no
 * session to bind and starts Global, keeping the unsent draft. Either way an
 * already-running attempt is mirrored and settled as-is — the target only ever
 * decides what a *start* creates.
 */
export const VoiceComposerPlanetMount = React.memo(function VoiceComposerPlanetMount(props: Readonly<{
    /** Explicit Session target (including unavailable) or intentional Global Voice. */
    target: VoiceAttemptIdleTarget;
    /** The retaining Session surface's existing presented fact, when it has one. */
    isPresented?: boolean;
}>): React.ReactElement | null {
    // AgentInput and the draft stay retained; the Voice presentation runtime
    // does not. The wrapper stays hook-free so a retained Session can change
    // presentation without changing this component's hook order.
    if (props.isPresented === false) return null;

    return <VoiceComposerPlanetPresentedMount target={props.target} />;
});

function VoiceComposerPlanetPresentedMount(props: Readonly<{
    target: VoiceAttemptIdleTarget;
}>): React.ReactElement | null {
    /*
     * The planet is drawn from the app's one energy clock; there is nothing to draw
     * it from without the bus. `app/(app)/_layout.tsx` wraps the whole authenticated
     * tree in `VoiceEnergyAppProvider` — pinned as source structure by
     * `voiceEnergyAppMount.test.ts` — so in the app this is always satisfied. It is a
     * rendering precondition, not a product gate, and it is checked before the
     * subscription so an unbused tree opens nothing at all.
     */
    const energy = useVoiceEnergyIfMounted();
    if (!energy) return null;
    return <VoiceComposerPlanetRuntime target={props.target} />;
}

function VoiceComposerPlanetRuntime(props: Readonly<{
    target: VoiceAttemptIdleTarget;
}>): React.ReactElement | null {
    const idleTarget = props.target;
    const control = useVoiceAttemptControl(idleTarget);
    const shortcutLabel = useKeyboardShortcutLabel('voice.toggle');
    const holdEnabled = useLocalSetting('voiceHoldToTalkEnabled');
    const isActivelyFocused = useHostActivelyFocused();
    const onHoldUnavailable = React.useCallback(() => {
        Modal.alert(t('voicePresence.holdToTalkTitle'), t('voicePresence.holdToTalkUnavailable', { service: control.serviceTitle ?? t('voicePresence.title') }));
    }, [control.serviceTitle]);
    const { availability, live, muted, primaryAction, primaryActionHint, primaryActionLabel, onPrimaryAction } = control;
    const startsGlobal = idleTarget.kind === 'global';
    const holdHint = holdEnabled
        ? control.canHoldToTalk ? t('voicePresence.holdToTalkHint') : t('voicePresence.holdToTalkUnavailable', { service: control.serviceTitle ?? t('voicePresence.title') })
        : null;

    // A transport that cannot do anything is worse than no transport (§2.5).
    if (availability === 'unavailable') return null;

    return (
        <VoiceComposerPlanet
            pose={resolveVoiceMarkPose(control)}
            markEvent={control.markEvent}
            muted={live && muted}
            tooltip={[primaryAction === 'start'
                ? [t('voicePresence.talkWithVoice'), shortcutLabel].filter(Boolean).join(' ')
                : primaryActionLabel, holdHint].filter(Boolean).join('\n')}
            /*
             * "Start Global Voice" rather than "Start Voice" in New Session: the two do different
             * things and a screen-reader user cannot see which composer they are in (§2.5).
             */
            accessibilityLabel={
                primaryAction === 'start' && startsGlobal
                    ? t('voiceAssistant.startGlobalVoice')
                    : primaryActionLabel ?? ''
            }
            accessibilityHint={
                [primaryAction === 'start' && startsGlobal
                    ? t('voiceSurface.composerGlobalStartHint')
                    : primaryActionHint, holdHint].filter(Boolean).join(' ')
            }
            disabled={primaryAction === null}
            isActivelyFocused={isActivelyFocused}
            onPress={onPrimaryAction}
            beginHoldToTalk={holdEnabled ? control.beginHoldToTalk : undefined}
            onHoldUnavailable={onHoldUnavailable}
        />
    );
}
