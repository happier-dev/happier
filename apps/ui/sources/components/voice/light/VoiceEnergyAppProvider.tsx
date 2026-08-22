import * as React from 'react';

import { useVoiceLevelSourceActivity } from '@/components/voice/surface/useVoiceLevelSourceActive';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { useSetting } from '@/sync/domains/state/storage';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';

import { resolveVoiceEnergyState } from './resolveVoiceEnergyState';
import { resolveVoiceEnergyRuntimeActivation } from './resolveVoiceEnergyRuntimeActivation';
import { VoiceEnergyProvider } from './useVoiceEnergy';

const VoiceInputSourceActivityContext = React.createContext(false);

/**
 * The one app-level microphone-capture projection. Presentation leaves consume
 * this provider value instead of subscribing to the level store themselves.
 */
export function useVoiceInputSourceActive(): boolean {
    return React.useContext(VoiceInputSourceActivityContext);
}

/**
 * The app's one Voice energy clock.
 *
 * §4.2 rule 6 — Horizon, the Orb and the composer planet read the same shared
 * values, so there is exactly one frame callback for the whole app rather than
 * one per surface. The rule's originally named site does not work:
 * `AuthenticatedAppRuntimeMounts` renders null-returning *siblings*, not a
 * wrapper, and a context provider has to wrap. This mounts around the tree in
 * the root `app/_layout.tsx` instead — a corrected derivation, recorded here
 * rather than left as a silent deviation.
 *
 * It re-renders when the Voice setting or the session status changes — a
 * handful of times per conversation, never per audio frame. Its `children`
 * element comes from the layout above and is referentially stable across those
 * renders, so React skips the whole app subtree; the amplitude itself never
 * touches React at all.
 */

export function VoiceEnergyAppProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const voice: unknown = useSetting('voice');
    const snapshot = useVoiceSessionSnapshot();
    /*
     * The microphone's *lifecycle*, not its amplitude: this hook re-renders only
     * when a capture source opens or closes — a handful of times per
     * conversation — while the amplitude itself stays on the shared-value path
     * and never reaches React. §2.4a's respiration gate needs the lifecycle fact.
     */
    const sourceActivity = useVoiceLevelSourceActivity();
    const inputSourceActive = sourceActivity.inputSourceActive;

    /*
     * The canonical resolver, memoized on the setting's identity and the running attempt's
     * adapter: it walks the provider registry and projects the provider's settings envelope,
     * which is far too much work to repeat on an unrelated render.
     *
     * The attempt is part of the key because the light must follow the provider that is
     * actually running. Selecting Off (or another provider) mid-attempt only chooses the next
     * idle admission, and a light that read the selection would go dark while the microphone
     * was still open.
     */
    const attemptAdapterId = snapshot.adapterId;
    const providerId = React.useMemo(
        () => resolveVoicePresentedProviderId({ adapterId: attemptAdapterId }, voiceSettingsParse(voice)),
        [attemptAdapterId, voice],
    );

    /*
     * The same canonical projection Horizon and the floating attempt control
     * consume. It changes only at lifecycle boundaries; level/source writes
     * stay entirely on the SharedValue/worklet path below this component.
     *
     * `inputSourceActive` is deliberately absent. It gates truthful microphone
     * capture/respiration through `activation`, but an open producer is not a
     * semantic "user speaking" signal and must not choose a light state.
     */
    const surfaceState = resolveVoiceSurfaceState({
        status: snapshot.status,
        mode: snapshot.mode,
        errorPresentation: snapshot.errorPresentation,
        presentationState: snapshot.presentationState,
    });
    const energyState = resolveVoiceEnergyState(surfaceState);

    const activation = React.useMemo(
        () => resolveVoiceEnergyRuntimeActivation({
            providerId,
            status: snapshot.status,
            inputSourceActive,
        }),
        [inputSourceActive, providerId, snapshot.status],
    );

    return (
        <VoiceInputSourceActivityContext.Provider value={inputSourceActive}>
            <VoiceEnergyProvider state={energyState} activation={activation} sourceActivity={sourceActivity}>
                {props.children}
            </VoiceEnergyProvider>
        </VoiceInputSourceActivityContext.Provider>
    );
}
