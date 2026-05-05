const VISUAL_MODE_SUFFIX_BY_ID = Object.freeze({
    notch_integrated: 'notch',
    floating_overlay: 'floating',
});

export const desktopActivityOverlayQaCardSeedIds = Object.freeze({
    permission_request: 'qa-permission-request',
    user_question: 'qa-user-question',
    quota_summary: 'qa-quota-summary',
    completion_state: 'qa-completion-state',
});

function normalizeTextSegment(value, fallback = 'unknown') {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : fallback;
}

export function normalizeDesktopActivityOverlayCardKindForTestID(kind) {
    const normalized = normalizeTextSegment(kind);
    if (normalized === 'idle' || normalized === 'idle_state') {
        return 'idle';
    }
    return normalized;
}

function resolveCardInstanceIdFromCard(card) {
    const normalizedKind = normalizeDesktopActivityOverlayCardKindForTestID(card?.kind);

    switch (normalizedKind) {
        case 'idle':
            return 'idle';
        case 'permission_request':
        case 'user_question':
            return normalizeTextSegment(card?.requestId ?? card?.id);
        case 'quota_summary':
            return normalizeTextSegment(card?.id);
        case 'completion_state':
            return normalizeTextSegment(card?.id ?? card?.sessionId);
        case 'session_overview':
            return normalizeTextSegment(card?.sessionId ?? card?.id);
        case 'multi_session_list':
            return normalizeTextSegment(card?.id, 'list');
        default:
            return normalizeTextSegment(card?.id);
    }
}

export function resolveDesktopActivityOverlaySurfaceTestID(baseTestID, visualMode) {
    const suffix = VISUAL_MODE_SUFFIX_BY_ID[visualMode];
    if (!suffix) {
        throw new Error(`Unsupported desktop activity overlay visual mode: ${String(visualMode)}`);
    }
    return `${normalizeTextSegment(baseTestID)}-${suffix}`;
}

export function resolveDesktopActivityOverlaySurfaceSelector(baseTestID, visualMode) {
    return `[data-testid="${resolveDesktopActivityOverlaySurfaceTestID(baseTestID, visualMode)}"]`;
}

export function resolveDesktopActivityOverlayCardKindTestID(kind) {
    return `desktop-activity-overlay-card-kind-${normalizeDesktopActivityOverlayCardKindForTestID(kind)}`;
}

export function resolveDesktopActivityOverlayCardKindSelector(kind) {
    return `[data-testid="${resolveDesktopActivityOverlayCardKindTestID(kind)}"]`;
}

export function resolveDesktopActivityOverlayCardInstanceTestID(card) {
    const normalizedKind = normalizeDesktopActivityOverlayCardKindForTestID(card?.kind);
    const instanceId = resolveCardInstanceIdFromCard(card);
    return `desktop-activity-overlay-card-${normalizedKind}-${instanceId}`;
}

export function resolveDesktopActivityOverlayCardSelectorByKind(kind, cardInstanceId = null) {
    const normalizedKind = normalizeDesktopActivityOverlayCardKindForTestID(kind);
    const resolvedCardInstanceId = normalizeTextSegment(
        cardInstanceId,
        normalizedKind === 'multi_session_list'
            ? 'list'
            : normalizedKind === 'idle'
                ? 'idle'
                : 'unknown',
    );
    return `[data-testid="desktop-activity-overlay-card-${normalizedKind}-${resolvedCardInstanceId}"]`;
}

export function resolveDesktopActivityOverlayCardActionKindTestID(actionId) {
    return `desktop-activity-overlay-card-action-kind-${normalizeTextSegment(actionId)}`;
}

export function resolveDesktopActivityOverlayCardActionInstanceTestID(cardId, actionId) {
    return `desktop-activity-overlay-card-action-${normalizeTextSegment(cardId)}-${normalizeTextSegment(actionId)}`;
}
