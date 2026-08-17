import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';

import type { VoiceEnergyState } from './useVoiceEnergy';

/**
 * The design-lab state tokens promoted to the production energy owner.
 *
 * These values describe the conversation's resting light and travel. Real
 * amplitude remains owned by `VoiceEnergyProvider`'s input/output SharedValues;
 * no level or `sourceActive` fact enters this semantic projection. That
 * separation is load-bearing: an open microphone producer is not proof that
 * the user is speaking.
 */
const ENERGY_BY_STATE: Readonly<Record<VoiceSurfaceState, VoiceEnergyState>> = Object.freeze({
    idle: Object.freeze({ luminosity: 0.18, energized: false, direction: 'none' }),
    connecting: Object.freeze({ luminosity: 0.4, energized: false, direction: 'orbit' }),
    listening: Object.freeze({ luminosity: 0.55, energized: true, direction: 'inward' }),
    transcribing: Object.freeze({ luminosity: 0.5, energized: false, direction: 'inward' }),
    thinking: Object.freeze({ luminosity: 0.62, energized: false, direction: 'orbit' }),
    speaking: Object.freeze({ luminosity: 0.92, energized: true, direction: 'outward' }),
    reconnecting: Object.freeze({ luminosity: 0.38, energized: false, direction: 'unsettled' }),
    permission_required: Object.freeze({ luminosity: 0.55, energized: false, direction: 'hold' }),
    error: Object.freeze({ luminosity: 0.3, energized: false, direction: 'none' }),
    interrupted: Object.freeze({ luminosity: 0.5, energized: true, direction: 'inward' }),
});

/**
 * Projects the one canonical Voice surface state onto the app's one energy bus.
 *
 * `Record<VoiceSurfaceState, ...>` is intentionally exhaustive: adding a
 * lifecycle state cannot silently fall back to idle light in Horizon, the Orb
 * and the composer at once.
 */
export function resolveVoiceEnergyState(state: VoiceSurfaceState): VoiceEnergyState {
    return ENERGY_BY_STATE[state];
}
