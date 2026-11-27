import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { canDismissVoiceSessionFailedAttempt } from '@/voice/session/voiceSessionStore';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

import { resolveVoiceAttemptControl, type VoiceAttemptControl } from './resolveVoiceAttemptControl';

/** Shared snapshot mapping; callers supply their capture, admission, recovery and setup context. */
export function projectVoiceAttemptControlSnapshot(input: Readonly<{
    snapshot: VoiceSessionSnapshot;
    capturing: boolean;
    startAdmitted: boolean;
    hasRecovery: boolean;
    setupOffered: boolean;
    sessionStatus?: Parameters<typeof resolveVoiceAttemptControl>[0]['sessionStatus'];
}>): VoiceAttemptControl {
    const { snapshot } = input;
    const surfaceState = resolveVoiceSurfaceState(snapshot);
    return resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: snapshot.status,
        sessionId: snapshot.sessionId ?? null,
        canStop: snapshot.canStop === true,
        canCommitInput: snapshot.canCommitInput === true,
        inputEndsOnSilence: snapshot.inputEndsOnSilence === true,
        muted: snapshot.micMuted === true,
        capturing: input.capturing,
        startAdmitted: input.startAdmitted,
        hasRecovery: input.hasRecovery,
        canDismissFailedAttempt: canDismissVoiceSessionFailedAttempt(snapshot),
        setupOffered: input.setupOffered,
        sessionStatus: input.sessionStatus,
    });
}
