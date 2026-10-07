import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    projectUiSessionRuntimeAwareness,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import { deriveLatestPendingRequestObservedAtFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { isSessionAdmittedToPersonalActivity } from '@/activity/attention/isSessionAdmittedToPersonalActivity';
import { resolveSessionPersonalAttentionForViewer } from '@/sync/domains/session/readState/sessionViewerAttention';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

import {
    PET_COMPANION_ACTIVITY_EXPIRY_MS,
    PET_COMPANION_ACTIVITY_PRIORITY,
} from './petCompanionActivityConstants';
import type {
    BuildPetCompanionActivityModelInput,
    PetCompanionActivityModel,
    PetCompanionActivityStatus,
    PetCompanionSessionSignals,
    PetCompanionTrayItem,
} from './petCompanionActivityTypes';

type SessionActivityCandidate = Readonly<{
    address: SessionAddress;
    session: Session;
    status: Exclude<PetCompanionActivityStatus, 'idle'>;
    activityAtMs: number | null;
    expiresAtMs: number | null;
}>;

function normalizeDismissedKeys(input: BuildPetCompanionActivityModelInput): ReadonlySet<string> {
    const keys = input.dismissedTrayItemKeys;
    if (!keys) return new Set<string>();
    return keys instanceof Set ? keys : new Set(keys);
}

function isFiniteTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveTimestamp(value: unknown): value is number {
    return isFiniteTimestamp(value) && value > 0;
}

function latestTimestamp(values: readonly unknown[]): number | null {
    let latest: number | null = null;
    for (const value of values) {
        if (!isPositiveTimestamp(value)) continue;
        latest = latest === null ? value : Math.max(latest, value);
    }
    return latest;
}

function latestConversationActivityTimestamp(
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
): number | null {
    return latestTimestamp([
        signals?.latestMeaningfulActivityAtMs,
        signals?.latestThinkingActivityAtMs,
        session.thinkingAt,
        session.optimisticThinkingAt,
        session.createdAt,
    ]);
}

function latestProjectedFailureTimestamp(session: Session): number | null {
    return latestTimestamp([
        session.lastRuntimeIssue?.occurredAt,
        session.latestTurnStatus === 'failed' ? session.latestTurnStatusObservedAt : null,
    ]);
}

function latestRunningRuntimeSignalTimestamp(
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
): number | null {
    return latestTimestamp([
        signals?.latestThinkingActivityAtMs,
        session.thinkingAt,
        session.latestTurnStatus === 'in_progress'
            ? session.latestTurnStatusObservedAt
            : null,
    ]);
}

function resolveRunningExpiresAtMs(runtimeSignalAtMs: number | null): number | null {
    return runtimeSignalAtMs === null
        ? null
        : runtimeSignalAtMs + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS;
}

function resolveCandidate(
    address: SessionAddress,
    session: Session,
    signals: PetCompanionSessionSignals | undefined,
    nowMs: number | undefined,
): SessionActivityCandidate | null {
    if (!isSessionAdmittedToPersonalActivity(session)) return null;
    const runtimeNowMs = isFiniteTimestamp(nowMs) ? nowMs : Date.now();
    const personal = resolveSessionPersonalAttentionForViewer(session, runtimeNowMs);
    const runtimePresentation = projectUiSessionRuntimeAwareness({
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        hasPendingUserMessages: (session.pendingCount ?? 0) > 0,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests:
            (session.pendingPermissionRequestCount ?? 0) > 0
            || signals?.hasPendingPermissionRequests === true,
        hasPendingUserActionRequests:
            (session.pendingUserActionRequestCount ?? 0) > 0
            || signals?.hasPendingUserActionRequests === true,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session),
        nowMs: runtimeNowMs,
    });
    if (session.viewer ? personal.reasons.includes('failed') : runtimePresentation.operational.primary === 'failed') {
        const activityAtMs =
            latestProjectedFailureTimestamp(session)
            ?? latestConversationActivityTimestamp(session, signals);
        return {
            address,
            session,
            status: 'failed',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.failed,
        };
    }

    if (session.viewer ? personal.reasons.some((reason) => reason === 'permission_required' || reason === 'user_action_required' || reason === 'pending_blocked') : runtimePresentation.operational.primary === 'permission_required' || runtimePresentation.operational.primary === 'action_required') {
        const activityAtMs = latestConversationActivityTimestamp(session, signals);
        return {
            address,
            session,
            status: 'waiting',
            activityAtMs,
            expiresAtMs: activityAtMs === null ? null : activityAtMs + PET_COMPANION_ACTIVITY_EXPIRY_MS.waiting,
        };
    }

    if (session.viewer ? personal.reasons.some((reason) => reason === 'unread' || reason === 'unread_discussion' || reason === 'mentioned') : signals?.hasUnreadMessages) {
        const activityAtMs = latestConversationActivityTimestamp(session, signals);
        return {
            address,
            session,
            status: 'waiting',
            activityAtMs,
            expiresAtMs: null,
        };
    }

    const hasRunningActivity = runtimePresentation.runtime === 'working' && runtimePresentation.freshness === 'live';

    if (hasRunningActivity) {
        const runtimeSignalAtMs = latestRunningRuntimeSignalTimestamp(session, signals);
        const activityAtMs = latestTimestamp([
            runtimeSignalAtMs,
            session.createdAt,
        ]);
        return {
            address,
            session,
            status: 'running',
            activityAtMs,
            expiresAtMs: runtimePresentation.projectedTurnInProgress
                ? null
                : resolveRunningExpiresAtMs(runtimeSignalAtMs),
        };
    }

    return null;
}

function isExpired(candidate: SessionActivityCandidate, nowMs: number | undefined): boolean {
    if (!isFiniteTimestamp(nowMs)) return false;
    return candidate.expiresAtMs !== null && nowMs > candidate.expiresAtMs;
}

function createDismissKey(candidate: SessionActivityCandidate): string {
    if (candidate.status === 'running' || candidate.expiresAtMs === null) {
        return JSON.stringify([
            candidate.status,
            candidate.address.serverId,
            candidate.address.sessionId,
            'live',
        ]);
    }

    return JSON.stringify([
        candidate.status,
        candidate.address.serverId,
        candidate.address.sessionId,
        candidate.activityAtMs === null ? 'live' : String(candidate.activityAtMs),
    ]);
}

function createTrayItemId(candidate: SessionActivityCandidate): string {
    return JSON.stringify([
        candidate.status,
        candidate.address.serverId,
        candidate.address.sessionId,
    ]);
}

function createTrayItem(
    candidate: SessionActivityCandidate,
    signals: PetCompanionSessionSignals | undefined,
    context: Readonly<{ contextLine: string | null; accessibilityContext: string | null }>,
    nowMs: number,
): PetCompanionTrayItem {
    const { contextLine } = context;
    const isStatusOnly = candidate.session.viewer?.attention.presentation === 'status_only';
    const mayShowPrivateContent = !isStatusOnly
        && isSessionAwarenessContentReadableV1(projectUiSessionAwareness(candidate.session, nowMs).encryption);
    const dismissKey = createDismissKey(candidate);
    const isLiveActivity = candidate.status === 'running' || candidate.expiresAtMs === null;
    return {
        id: createTrayItemId(candidate),
        dismissKey,
        address: candidate.address,
        sessionId: candidate.session.id,
        contextLine,
        accessibilityContext: context.accessibilityContext,
        status: candidate.status,
        priority: PET_COMPANION_ACTIVITY_PRIORITY[candidate.status],
        title: mayShowPrivateContent ? getSessionName(candidate.session) : t('sessionBoard.item.locked.title'),
        // The shared context line is authorized structural context and survives a locked
        // envelope and Lane 09's status-only presentation: Home, audience, responsibility and
        // freshness are never private content (L07-R42, child 04 :255). Only the
        // message-derived fallback waits for content readiness and status-only admission.
        subtitle: contextLine ?? (
            isStatusOnly
            || !mayShowPrivateContent
            || (isLiveActivity && candidate.status === 'running')
                ? null
                : signals?.lastMessageSubtitle ?? null
        ),
        activityAtMs: isLiveActivity ? null : candidate.activityAtMs,
        expiresAtMs: candidate.expiresAtMs,
        actions: {
            open: true,
            dismiss: true,
            quickReply: true,
        },
    };
}

function compareTrayItems(
    selectedAddress: SessionAddress | null,
    a: PetCompanionTrayItem,
    b: PetCompanionTrayItem,
): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (areSessionAddressesEqual(a.address, selectedAddress) && !areSessionAddressesEqual(b.address, selectedAddress)) return -1;
    if (areSessionAddressesEqual(b.address, selectedAddress) && !areSessionAddressesEqual(a.address, selectedAddress)) return 1;
    const aActivity = a.activityAtMs ?? Number.NEGATIVE_INFINITY;
    const bActivity = b.activityAtMs ?? Number.NEGATIVE_INFINITY;
    if (aActivity !== bActivity) return bActivity - aActivity;
    return sessionAddressKey(a.address).localeCompare(sessionAddressKey(b.address));
}

function resolveSessionAddress(session: Session): SessionAddress | null {
    return normalizeSessionAddress(session.serverId, session.id);
}

function resolveSelectedAddress(input: BuildPetCompanionActivityModelInput): SessionAddress | null {
    if (input.selectedAddress) return input.selectedAddress;
    const selectedId = typeof input.selectedSessionId === 'string' ? input.selectedSessionId.trim() : '';
    if (!selectedId) return null;
    const matches = input.sessions
        .filter((session) => session.id === selectedId)
        .map(resolveSessionAddress)
        .filter((address): address is SessionAddress => address !== null);
    return matches.length === 1 ? matches[0] : null;
}

function selectFallbackAddress(input: BuildPetCompanionActivityModelInput): SessionAddress | null {
    const selectedAddress = resolveSelectedAddress(input);
    if (selectedAddress) {
        const selected = input.sessions.find((session) => areSessionAddressesEqual(
            resolveSessionAddress(session),
            selectedAddress,
        ));
        if (selected) return selectedAddress;
    }
    const fallback = input.sessions.find((session) => session.active) ?? input.sessions[0] ?? null;
    return fallback ? resolveSessionAddress(fallback) : null;
}

export function buildPetCompanionActivityModel(
    input: BuildPetCompanionActivityModelInput,
): PetCompanionActivityModel {
    const selectedAddress = resolveSelectedAddress(input);
    const nowMs = isFiniteTimestamp(input.nowMs) ? input.nowMs : Date.now();
    const dismissedKeys = normalizeDismissedKeys(input);
    const trayItems = input.sessions
        .map((session) => {
            const address = resolveSessionAddress(session);
            if (!address) return null;
            const addressKey = sessionAddressKey(address);
            const signals = input.signalsByAddressKey?.[addressKey]
                ?? input.signalsBySessionId?.[session.id];
            const candidate = resolveCandidate(address, session, signals, nowMs);
            const context = input.contextsByAddressKey?.[addressKey] ?? null;
            return candidate ? {
                candidate,
                signals,
                context: {
                    contextLine: context?.contextLine ?? null,
                    accessibilityContext: context?.accessibilityContext ?? null,
                },
            } : null;
        })
        .filter((entry): entry is Readonly<{
            candidate: SessionActivityCandidate;
            signals: PetCompanionSessionSignals | undefined;
            context: Readonly<{ contextLine: string | null; accessibilityContext: string | null }>;
        }> => entry !== null)
        .filter(({ candidate }) => !isExpired(candidate, nowMs))
        .map(({ candidate, signals, context }) => createTrayItem(candidate, signals, context, nowMs))
        .filter((item) => !dismissedKeys.has(item.dismissKey))
        .sort((a, b) => compareTrayItems(selectedAddress, a, b));
    const primary = trayItems[0] ?? null;

    if (primary) {
        return {
            state: primary.status,
            reason: primary.status,
            address: primary.address,
            sessionId: primary.sessionId,
            trayItems,
        };
    }

    const fallbackAddress = selectFallbackAddress(input);
    return {
        state: 'idle',
        reason: 'idle',
        address: fallbackAddress,
        sessionId: fallbackAddress?.sessionId ?? null,
        trayItems,
    };
}
