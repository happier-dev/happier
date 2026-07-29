export type SessionLiveTranscriptReason =
    | 'visible'
    | 'explicitTranscriptConsumer'
    | 'voicePrimaryAction'
    | 'voiceTracked'
    | 'voiceReadback'
    | 'voiceBoundTarget'
    | 'scmSameSession';

export type SessionRealtimeScmScope = Readonly<{
    sessionId?: string | null;
    canonicalProjectKey?: string | null;
    machineScopeId?: string | null;
    repoRoot?: string | null;
    needsMutationTranscript?: boolean;
}>;

export type SessionNeedsLiveTranscriptInput = Readonly<{
    sessionId: string;
    isVisible?: boolean;
    explicitTranscriptConsumerSessionIds?: ReadonlyArray<string>;
    voicePrimaryActionSessionId?: string | null;
    voiceTrackedSessionIds?: ReadonlyArray<string>;
    voiceReadbackSessionIds?: ReadonlyArray<string>;
    voiceBoundTargetSessionIds?: ReadonlyArray<string>;
    scmMountedScopes?: ReadonlyArray<SessionRealtimeScmScope>;
}>;

export type SessionNeedsLiveTranscriptDecision = Readonly<{
    active: boolean;
    reasons: readonly SessionLiveTranscriptReason[];
}>;

function normalizeText(value: unknown): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

function includesSessionId(values: ReadonlyArray<string> | undefined, sessionId: string): boolean {
    return values?.some((value) => normalizeText(value) === sessionId) === true;
}

function pushReason(reasons: SessionLiveTranscriptReason[], reason: SessionLiveTranscriptReason): void {
    if (!reasons.includes(reason)) reasons.push(reason);
}

function isSameCanonicalProjectScope(
    sessionScope: SessionRealtimeScmScope | null | undefined,
    mountedScope: SessionRealtimeScmScope,
): boolean {
    const sessionProjectKey = normalizeText(sessionScope?.canonicalProjectKey);
    const mountedProjectKey = normalizeText(mountedScope.canonicalProjectKey);
    return Boolean(sessionProjectKey && mountedProjectKey && sessionProjectKey === mountedProjectKey);
}

export function sessionNeedsLiveTranscript(input: SessionNeedsLiveTranscriptInput): SessionNeedsLiveTranscriptDecision {
    const sessionId = normalizeText(input.sessionId);
    if (!sessionId) return { active: false, reasons: [] };

    const reasons: SessionLiveTranscriptReason[] = [];
    if (input.isVisible === true) pushReason(reasons, 'visible');
    if (includesSessionId(input.explicitTranscriptConsumerSessionIds, sessionId)) {
        pushReason(reasons, 'explicitTranscriptConsumer');
    }
    if (normalizeText(input.voicePrimaryActionSessionId) === sessionId) {
        pushReason(reasons, 'voicePrimaryAction');
    }
    if (includesSessionId(input.voiceTrackedSessionIds, sessionId)) {
        pushReason(reasons, 'voiceTracked');
    }
    if (includesSessionId(input.voiceReadbackSessionIds, sessionId)) {
        pushReason(reasons, 'voiceReadback');
    }
    if (includesSessionId(input.voiceBoundTargetSessionIds, sessionId)) {
        pushReason(reasons, 'voiceBoundTarget');
    }

    // Hidden sessions in the same canonical project scope intentionally do NOT become full
    // transcript consumers: their SCM mutation signal is delivered from the durable projection
    // path (see sessionScmMutationSignalWanted) so their transcripts stay projection-only.
    for (const scope of input.scmMountedScopes ?? []) {
        if (scope.needsMutationTranscript !== true) continue;
        if (normalizeText(scope.sessionId) === sessionId) {
            pushReason(reasons, 'scmSameSession');
        }
    }

    return { active: reasons.length > 0, reasons };
}

export function isSessionFullContentConsumerActive(input: SessionNeedsLiveTranscriptInput): boolean {
    return sessionNeedsLiveTranscript(input).active;
}

export type SessionScmMutationSignalInput = Readonly<{
    sessionId: string;
    sessionScmScope?: SessionRealtimeScmScope | null;
    scmMountedScopes?: ReadonlyArray<SessionRealtimeScmScope>;
}>;

/**
 * Whether a mounted SCM consumer wants workspace-mutation signals from this session.
 *
 * This intentionally covers hidden sessions in the same canonical project scope: instead of
 * hydrating their full live transcript (decrypt + reducer + store apply per streaming tick),
 * the realtime socket path feeds their skipped durable messages to the workspace-mutation
 * ingestion side channel when this predicate matches.
 */
export function sessionScmMutationSignalWanted(input: SessionScmMutationSignalInput): boolean {
    const sessionId = normalizeText(input.sessionId);
    if (!sessionId) return false;

    for (const scope of input.scmMountedScopes ?? []) {
        if (scope.needsMutationTranscript !== true) continue;
        if (normalizeText(scope.sessionId) === sessionId) return true;
        if (isSameCanonicalProjectScope(input.sessionScmScope, scope)) return true;
    }
    return false;
}
