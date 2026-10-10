import type { PlanetDotPose } from '@happier-dev/brand/planet';

import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import type { VoiceSessionEndedAttempt } from '@/voice/session/voiceSessionStore';

/** `mic` is the rest control; every other value is a Daybreak planet pose. */
export type VoiceMarkPose = 'mic' | PlanetDotPose;

/**
 * A real one-shot fact the mark plays once (lab vmGather / vmLeave): `gather` brings dots into the
 * planet, `leave` takes them back to the rest microphone. The id is the fact's identity, so the same
 * fact never plays twice.
 */
export type VoiceMarkEvent = Readonly<{ kind: 'gather' | 'leave'; id: string }>;

/**
 * The attempt's own continuation facts as a mark event: dots leave when this device ended its
 * microphone because the conversation continued on another device, and gather when this attempt
 * connected to a conversation last voiced on another device.
 */
export function resolveVoiceMarkEvent(input: Readonly<{
    ended: VoiceSessionEndedAttempt | null | undefined;
    arrivedAttemptId: string | null;
}>): VoiceMarkEvent | null {
    if (input.ended?.reason.kind === 'continued_elsewhere') {
        return { kind: 'leave', id: `${input.ended.attemptId ?? input.ended.endedAt}:leave` };
    }
    return input.arrivedAttemptId ? { kind: 'gather', id: `${input.arrivedAttemptId}:arrive` } : null;
}

/**
 * The attempt's semantic mark pose (owned by the attempt projection) drawn as a Brand planet pose:
 * Light = ready, Shadow = waiting on something outside, partial shade (rose) = failed or blocked.
 */
export function resolveVoiceMarkPose(voice: Pick<VoiceAttemptControlProjection, 'markPose'>): VoiceMarkPose {
    switch (voice.markPose) {
        case 'mic':
            return 'mic';
        case 'shadow':
            return 'shadow';
        case 'blocked':
            return 'shade';
        case 'light':
            return 'ready';
    }
}
