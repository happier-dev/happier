import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';

export type VoiceBriefOperation = 'request' | 'retry' | 'stop';
export type VoiceBriefOperationInput = Readonly<{ expectedAttemptId?: string }>;
export type VoiceBriefOperationOutcome =
    | Readonly<{ ok: true; result: Readonly<{ status: 'waiting' | 'sent' | 'refused' | 'stopped'; attemptId: string | null }> }>
    | Readonly<{ ok: false; errorCode: 'voice_brief_unavailable' | 'stale_voice_attempt' | 'voice_brief_not_retryable' | 'voice_brief_stop_unavailable' }>;

type MountedBriefOperation = (operation: VoiceBriefOperation) => VoiceBriefOperationOutcome;
let mountedBrief: MountedBriefOperation | null = null;
let mountedHomeRequest: (() => VoiceBriefOperationOutcome) | null = null;

/** The same demand-mounted Brief serves the Home button and Actions in this client/window. */
export function registerVoiceBriefOperations(execute: MountedBriefOperation): () => void {
    mountedBrief = execute;
    return () => { if (mountedBrief === execute) mountedBrief = null; };
}

/** Home supplies only presentation demand; it never builds Inbox context or starts media. */
export function registerVoiceBriefHomeRequest(request: () => VoiceBriefOperationOutcome): () => void {
    mountedHomeRequest = request;
    return () => { if (mountedHomeRequest === request) mountedHomeRequest = null; };
}

export function voiceBriefOperationResult(status: 'waiting' | 'sent' | 'refused' | 'stopped'): VoiceBriefOperationOutcome {
    return { ok: true, result: { status, attemptId: getVoiceSessionPresentedAttemptId() } };
}

export function executeVoiceBriefOperation(operation: VoiceBriefOperation, input: VoiceBriefOperationInput = {}): VoiceBriefOperationOutcome {
    if (input.expectedAttemptId !== undefined && input.expectedAttemptId !== getVoiceSessionPresentedAttemptId()) {
        return { ok: false, errorCode: 'stale_voice_attempt' };
    }
    if (mountedBrief) return mountedBrief(operation);
    if (operation === 'request' && mountedHomeRequest) return mountedHomeRequest();
    return { ok: false, errorCode: 'voice_brief_unavailable' };
}
