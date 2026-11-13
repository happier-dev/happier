import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

export type VoiceBriefOperation = 'request' | 'retry' | 'stop' | 'close';
export type VoiceBriefOperationInput = Readonly<{ expectedAttemptId?: string }>;
export type VoiceBriefOperationOutcome =
    | Readonly<{ ok: true; result: Readonly<{ status: 'waiting' | 'sent' | 'refused' | 'stopped' | 'closed'; attemptId: string | null }> }>
    | Readonly<{ ok: false; errorCode: 'voice_brief_unavailable' | 'stale_voice_attempt' | 'voice_brief_not_retryable' | 'voice_brief_stop_unavailable'; details?: ActionExecuteFailure['details']; failureCause?: ActionExecuteFailure['failureCause'] }>;

type MountedBriefOperation = (operation: VoiceBriefOperation) => VoiceBriefOperationOutcome;
let mountedBrief: MountedBriefOperation | null = null;
let mountedHomeRequest: (() => VoiceBriefOperationOutcome) | null = null;
let pendingHomeRequest: Readonly<{
    owner: (() => VoiceBriefOperationOutcome) | null;
    accountLifetime: ReturnType<typeof captureActiveServerAccountScopeCurrentness>;
    attemptId: string | null;
}> | null = null;

/** The same demand-mounted Brief serves the Home button and Actions in this client/window. */
export function registerVoiceBriefOperations(execute: MountedBriefOperation): () => void {
    mountedBrief = execute;
    return () => { if (mountedBrief === execute) mountedBrief = null; };
}

/** Home supplies only presentation demand; it never builds Inbox context or starts media. */
export function registerVoiceBriefHomeRequest(request: () => VoiceBriefOperationOutcome): () => void {
    mountedHomeRequest = request;
    // Navigation may mount Home after the admitted Action has returned waiting.
    if (pendingHomeRequest?.owner === null) {
        const pending = pendingHomeRequest;
        pendingHomeRequest = null;
        if (pending.accountLifetime.isCurrent() && pending.attemptId === getVoiceSessionPresentedAttemptId()) {
            pendingHomeRequest = { ...pending, owner: request };
            if (!request().ok) pendingHomeRequest = null;
        }
    }
    return () => {
        if (mountedHomeRequest === request) mountedHomeRequest = null;
        if (pendingHomeRequest?.owner === request) pendingHomeRequest = null;
    };
}

/** Continue the admitted Home request after its Inbox owner has demand-mounted, without re-admission. */
export function resumeVoiceBriefHomeRequest(): VoiceBriefOperationOutcome | null {
    if (!pendingHomeRequest || !mountedBrief) return null;
    const request = pendingHomeRequest;
    pendingHomeRequest = null;
    if (request.owner !== mountedHomeRequest || !request.accountLifetime.isCurrent()) {
        return voiceBriefUnavailable('ui.voice_global.brief.account_scope');
    }
    if (request.attemptId !== getVoiceSessionPresentedAttemptId()) return { ok: false, errorCode: 'stale_voice_attempt' };
    return mountedBrief('request');
}

export function voiceBriefOperationResult(status: 'waiting' | 'sent' | 'refused' | 'stopped' | 'closed'): VoiceBriefOperationOutcome {
    return { ok: true, result: { status, attemptId: getVoiceSessionPresentedAttemptId() } };
}

export function executeVoiceBriefOperation(operation: VoiceBriefOperation, input: VoiceBriefOperationInput = {}): VoiceBriefOperationOutcome {
    if (input.expectedAttemptId !== undefined && input.expectedAttemptId !== getVoiceSessionPresentedAttemptId()) {
        return { ok: false, errorCode: 'stale_voice_attempt' };
    }
    if (mountedBrief) return mountedBrief(operation);
    if (operation === 'request' && mountedHomeRequest) {
        const request = { owner: mountedHomeRequest, accountLifetime: captureActiveServerAccountScopeCurrentness(),
            attemptId: getVoiceSessionPresentedAttemptId() };
        pendingHomeRequest = request;
        const outcome = mountedHomeRequest();
        if (!outcome.ok && pendingHomeRequest === request) pendingHomeRequest = null;
        return outcome;
    }
    return voiceBriefUnavailable('ui.voice_global.brief.host');
}

export function voiceBriefUnavailable(phase: string): VoiceBriefOperationOutcome {
    return { ok: false, errorCode: 'voice_brief_unavailable', details: { retryable: false },
        failureCause: { phase, errorClass: 'Error', errorCode: null, httpStatus: null } };
}

/** Reach Home's existing demand-mounted producer from any Voice surface. */
export async function executeVoiceBriefOperationFromUi(operation: VoiceBriefOperation, input: VoiceBriefOperationInput,
    openHome: () => Promise<void>): Promise<VoiceBriefOperationOutcome> {
    if (operation !== 'request' || mountedBrief || mountedHomeRequest
        || (input.expectedAttemptId !== undefined && input.expectedAttemptId !== getVoiceSessionPresentedAttemptId())) {
        return executeVoiceBriefOperation(operation, input);
    }
    const pending = { owner: null, accountLifetime: captureActiveServerAccountScopeCurrentness(),
        attemptId: getVoiceSessionPresentedAttemptId() };
    pendingHomeRequest = pending;
    try {
        await openHome();
        return voiceBriefOperationResult('waiting');
    } catch (error) {
        if (pendingHomeRequest === pending) pendingHomeRequest = null;
        throw error;
    }
}
