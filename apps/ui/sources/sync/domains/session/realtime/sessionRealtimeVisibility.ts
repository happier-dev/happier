export type SessionLiveTranscriptReason =
    | 'visible'
    | 'explicitTranscriptConsumer'
    | 'voicePrimaryAction'
    | 'voiceTracked'
    | 'voiceReadback'
    | 'voiceBoundTarget'
    | 'scmSameSession'
    | 'scmSameProjectScope';

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
    sessionScmScope?: SessionRealtimeScmScope | null;
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

    for (const scope of input.scmMountedScopes ?? []) {
        if (scope.needsMutationTranscript !== true) continue;
        if (normalizeText(scope.sessionId) === sessionId) {
            pushReason(reasons, 'scmSameSession');
            continue;
        }
        if (isSameCanonicalProjectScope(input.sessionScmScope, scope)) {
            pushReason(reasons, 'scmSameProjectScope');
        }
    }

    return { active: reasons.length > 0, reasons };
}

export function isSessionFullContentConsumerActive(input: SessionNeedsLiveTranscriptInput): boolean {
    return sessionNeedsLiveTranscript(input).active;
}
