import * as React from 'react';

import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
    type VoiceAttemptIdleTarget,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useVoiceEnergyIfMounted } from '@/components/voice/light/useVoiceEnergy';
import { t } from '@/text';

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
    /** The composer's own session, or `null` in New Session where none exists yet. */
    sessionId: string | null;
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
    return <VoiceComposerPlanetRuntime sessionId={props.sessionId} />;
});

function VoiceComposerPlanetRuntime(props: Readonly<{
    sessionId: string | null;
}>): React.ReactElement | null {
    const sessionId = props.sessionId;
    const idleTarget = React.useMemo<VoiceAttemptIdleTarget>(
        () => {
            // `null` is the only Global sentinel: it is how New Session states that no session
            // exists yet. A present-but-blank session id is an invalid session target and must
            // retain that scope so `useVoiceAttemptControl` fails admission closed instead of
            // silently starting a different, Global conversation.
            if (sessionId === null) return VOICE_ATTEMPT_IDLE_TARGET_GLOBAL;
            return { kind: 'session', sessionId: sessionId.trim() };
        },
        [sessionId],
    );
    const control = useVoiceAttemptControl(idleTarget);
    const { availability, canStop, muted, primaryAction, primaryActionHint, primaryActionLabel, stop, onPrimaryAction } = control;
    const startsGlobal = idleTarget.kind === 'global';

    // A transport that cannot do anything is worse than no transport (§2.5).
    if (availability === 'unavailable') return null;

    return (
        <VoiceComposerPlanet
            live={canStop}
            muted={muted}
            stop={stop}
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
                primaryAction === 'start' && startsGlobal
                    ? t('voiceSurface.composerGlobalStartHint')
                    : primaryActionHint ?? ''
            }
            disabled={primaryAction === null}
            onPress={onPrimaryAction}
        />
    );
}
