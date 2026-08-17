import { resolveVoiceMicCaptureActive } from '@/voice/session/resolveVoiceMicCaptureActive';
import type { VoiceSessionStatus } from '@/voice/session/types';

import type { VoiceEnergyRuntimeActivation } from './useVoiceEnergy';

/**
 * The live runtime facts the app-shell energy provider hands the clock.
 *
 * Both are read from owners that already exist — the provider resolver and the
 * canonical session snapshot — so this stays a projection rather than a second
 * source of truth. It is a pure function for the same reason
 * `resolveVoiceEnergyActive` is: the activation predicate is the part of §2.4a
 * that a test can actually pin, and neither React nor Reanimated is needed to
 * decide it.
 */
export type VoiceEnergyRuntimeActivationInputs = Readonly<{
    /**
     * The provider id resolved for a Voice *surface* — `null` when Voice is
     * `off` or the selection no longer resolves to a conversation provider.
     *
     * Deliberately the surface resolver, not the binding-scope one: a provider
     * whose binding is broken is still selected, and the screen whose job is to
     * show that problem is a Voice surface like any other. §2.4a asks whether a
     * provider is enabled, not whether it can currently connect.
     */
    providerId: string | null;
    /** Canonical Voice session status (`useVoiceSessionSnapshot`). */
    status: VoiceSessionStatus;
    /**
     * The level store's microphone channel has an open writer
     * (`useVoiceLevelSourceActivity()` in the app-level energy provider).
     *
     * The attempt and the microphone are separate facts, and §2.4a turns on
     * exactly that separation: the runtime spends a real interval in
     * `acquiring_mic` where the status is already `connected` and no capture
     * exists. Respiration must follow the second fact, not the first.
     */
    inputSourceActive: boolean;
}>;

/**
 * Whether a Voice attempt exists right now.
 *
 * `connecting` and `connected` are exactly the two statuses the session store
 * treats as one attempt when it mints attempt ids (`voiceSessionStore.ts:24-26`,
 * module-private there). `error` is deliberately excluded: an attempt that
 * failed has ended, and §2.4a settles an ended attempt back to still rather
 * than animating an error indefinitely.
 */
function isVoiceAttemptActive(status: VoiceSessionStatus): boolean {
    return status === 'connecting' || status === 'connected';
}

export function resolveVoiceEnergyRuntimeActivation(
    inputs: VoiceEnergyRuntimeActivationInputs,
): VoiceEnergyRuntimeActivation {
    return {
        providerReady: inputs.providerId !== null,
        attemptActive: isVoiceAttemptActive(inputs.status),
        // The canonical capture predicate, shared with the Voice surface model
        // so a surface saying "microphone inactive" can never sit beside a
        // planet breathing as if it were open.
        micCaptureActive: resolveVoiceMicCaptureActive({
            status: inputs.status,
            inputSourceActive: inputs.inputSourceActive,
        }),
    };
}
