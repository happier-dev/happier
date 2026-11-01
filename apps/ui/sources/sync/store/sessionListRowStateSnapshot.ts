import type {
    SessionListRowStateSnapshot,
    SessionListRowStoreState,
} from '@/components/sessions/shell/row/sessionListRowModelTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    isSessionListRenderableWarmCacheProgressOnlyChange,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import {
    deriveSessionRuntimePresentationState,
    resolveNextSessionRuntimePresentationFreshnessAtMs,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';
import { nowServerMs } from '@/sync/runtime/time';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import { selectEffectiveSessionAppearanceColor, type SessionAppearanceSelectorState } from './selectors/sessionAppearance';
import { areSessionAppearanceColorsEqual, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import type { SessionWorkspacePresentationMetadata } from '@/sync/domains/session/listing/sessionWorkspacePresentation';

type SessionListRowStateSnapshotScope = Readonly<{
    sessionId: string;
    serverId?: string | null;
    metadata?: SessionWorkspacePresentationMetadata;
}>;

type SessionListRowStoreStateSelectorInput = SessionAppearanceSelectorState & Readonly<{
    sessions?: SessionListRowStoreState['sessions'];
    sessionListRenderables?: SessionListRowStoreState['sessionListRenderables'];
    sessionMessages?: SessionListRowStoreState['sessionMessages'];
    sessionPending?: SessionListRowStoreState['sessionPending'];
}>;

type MutableSessionListRowStoreState = {
    activeServerId?: string | null;
    sessions: Record<string, ReturnType<typeof selectSessionListRowStateSnapshot>['session']>;
    sessionListRenderables: Record<string, ReturnType<typeof selectSessionListRowStateSnapshot>['renderable']>;
    sessionMessages: Record<string, ReturnType<typeof selectSessionListRowStateSnapshot>['messages']>;
    sessionPending: Record<string, ReturnType<typeof selectSessionListRowStateSnapshot>['pending']>;
};

const EMPTY_RUNTIME_PRIORITY_ROW_SCOPES: readonly SessionListRowStateSnapshotScope[] = Object.freeze([]);

// Visible rows do not need to rebuild on every unread-stable streaming progress timestamp.
// Keep the store fully fresh, but let the row selector expose at most ~30s progress
// steps while relative labels remain equivalent; urgent unread/status/pending changes
// still flow through immediately via the warm-cache progress-only guard below.
const ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS = 30_000;

function normalizeId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeScope(scope: string | SessionListRowStateSnapshotScope): SessionListRowStateSnapshotScope {
    if (typeof scope === 'string') {
        return { sessionId: scope };
    }
    return scope;
}

function shouldReadActiveServerOverlay(
    state: SessionListRowStoreState,
    rowServerId: string | null | undefined,
): boolean {
    const activeServerId = normalizeId(state.activeServerId);
    const normalizedRowServerId = normalizeId(rowServerId);
    if (!activeServerId || !normalizedRowServerId) return true;
    return areServerProfileIdentifiersEquivalent(activeServerId, normalizedRowServerId);
}

export function selectSessionListRowStateSnapshot(
    state: SessionListRowStoreState,
    scope: string | SessionListRowStateSnapshotScope,
): SessionListRowStateSnapshot {
    const normalizedScope = normalizeScope(scope);
    const sessionId = normalizedScope.sessionId;
    const key = `${normalizedScope.serverId ?? state.activeServerId ?? ''}:${sessionId}`;
    const appearanceColor = state.appearanceColorsBySessionKey?.[key] ?? null;
    if (!shouldReadActiveServerOverlay(state, normalizedScope.serverId)) {
        return {
            session: undefined,
            renderable: undefined,
            messages: undefined,
            pending: undefined,
            appearanceColor,
        };
    }

    return {
        session: state.sessions?.[sessionId],
        renderable: state.sessionListRenderables?.[sessionId],
        messages: state.sessionMessages?.[sessionId],
        pending: state.sessionPending?.[sessionId],
        appearanceColor,
    };
}

function countChangedRefs(previous: readonly unknown[] | null, next: readonly unknown[]): number {
    if (previous === null) return next.length;
    const maxLength = Math.max(previous.length, next.length);
    let changed = 0;
    for (let index = 0; index < maxLength; index += 1) {
        if (previous[index] !== next[index]) changed += 1;
    }
    return changed;
}

function recordRowStoreSelectorChangeTelemetry(fields: Readonly<Record<string, number>>): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    syncPerformanceTelemetry.count('ui.sessionsList.rowStoreSelector.changed', fields);
}

function recordRowStoreSelectorSuppressedTelemetry(fields: Readonly<Record<string, number>>): void {
    if (!syncPerformanceTelemetry.isEnabled()) return;
    syncPerformanceTelemetry.count('ui.sessionsList.rowStoreSelector.progressOnlySuppressed', fields);
}

function finiteTimestamp(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function resolveProgressTimestamp(renderable: SessionListRenderableSession): number | null {
    const updatedAt = finiteTimestamp(renderable.updatedAt);
    const meaningfulActivityAt = finiteTimestamp(renderable.meaningfulActivityAt);
    if (updatedAt === null) return meaningfulActivityAt;
    if (meaningfulActivityAt === null) return updatedAt;
    return Math.max(updatedAt, meaningfulActivityAt);
}

function canReuseActiveHeartbeatAdvance(input: Readonly<{
    previous: SessionListRenderableSession;
    next: SessionListRenderableSession;
    nowMs: number;
}>): boolean {
    const { previous, next, nowMs } = input;
    if (previous.activeAt === next.activeAt) return true;

    const previousActiveAt = finiteTimestamp(previous.activeAt);
    const nextActiveAt = finiteTimestamp(next.activeAt);
    if (previousActiveAt === null || nextActiveAt === null) return false;
    if (nextActiveAt <= previousActiveAt) return false;
    if (nextActiveAt - previousActiveAt >= ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS) return false;

    return previousActiveAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - nowMs
        > ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS;
}

function hasSameRelativeProgressLabels(
    previous: SessionListRenderableSession,
    next: SessionListRenderableSession,
    nowMs: number,
): boolean {
    const previousUpdatedAt = finiteTimestamp(previous.updatedAt);
    const nextUpdatedAt = finiteTimestamp(next.updatedAt);
    if (previousUpdatedAt !== null && nextUpdatedAt !== null) {
        if (formatShortRelativeTimeAt(previousUpdatedAt, nowMs) !== formatShortRelativeTimeAt(nextUpdatedAt, nowMs)) {
            return false;
        }
    }

    const previousMeaningfulActivityAt = finiteTimestamp(previous.meaningfulActivityAt);
    const nextMeaningfulActivityAt = finiteTimestamp(next.meaningfulActivityAt);
    if (previousMeaningfulActivityAt !== null && nextMeaningfulActivityAt !== null) {
        if (
            formatShortRelativeTimeAt(previousMeaningfulActivityAt, nowMs)
            !== formatShortRelativeTimeAt(nextMeaningfulActivityAt, nowMs)
        ) {
            return false;
        }
    }

    return true;
}

function shouldReusePreviousProgressRenderable(input: Readonly<{
    previous: SessionListRenderableSession | undefined;
    next: SessionListRenderableSession | undefined;
    nowMs: number;
}>): input is Readonly<{ previous: SessionListRenderableSession; next: SessionListRenderableSession; nowMs: number }> {
    const { previous, next, nowMs } = input;
    if (!previous || !next || previous === next) return false;
    if (!isSessionListRenderableWarmCacheProgressOnlyChange(previous, next)) return false;
    if (!canReuseActiveHeartbeatAdvance({ previous, next, nowMs })) return false;

    const previousTimestamp = resolveProgressTimestamp(previous);
    const nextTimestamp = resolveProgressTimestamp(next);
    if (previousTimestamp === null || nextTimestamp === null) return false;
    if (nextTimestamp <= previousTimestamp) return false;
    if (nextTimestamp - previousTimestamp >= ROW_PROGRESS_RENDERABLE_MIN_UPDATE_INTERVAL_MS) return false;

    return hasSameRelativeProgressLabels(previous, next, nowMs);
}

function isRuntimePriorityRenderable(
    renderable: SessionListRenderableSession | undefined,
    nowMs: number,
): boolean {
    if (!renderable) return false;
    const runtimeStatus = deriveSessionRuntimePresentationState(renderable, nowMs);
    return runtimeStatus.working
        || (runtimeStatus.isOnline && runtimeStatus.backgroundActive)
        || runtimeStatus.freshPermissionRequired
        || runtimeStatus.freshActionRequired
        || renderable.hasPendingPermissionRequests === true
        || renderable.hasPendingUserActionRequests === true;
}

function areScopeListsEqual(
    previous: readonly SessionListRowStateSnapshotScope[] | null,
    next: readonly SessionListRowStateSnapshotScope[],
): boolean {
    if (previous === null || previous.length !== next.length) return false;
    for (let index = 0; index < next.length; index += 1) {
        const previousScope = previous[index];
        const nextScope = next[index];
        if (!previousScope || !nextScope) return false;
        if (previousScope.sessionId !== nextScope.sessionId) return false;
        if ((previousScope.serverId ?? null) !== (nextScope.serverId ?? null)) return false;
    }
    return true;
}

export function createSessionListRuntimePriorityRowScopeSelector(
    scopes: readonly SessionListRowStateSnapshotScope[],
    activeServerId: string | null | undefined,
): (state: SessionListRowStoreStateSelectorInput) => readonly SessionListRowStateSnapshotScope[] {
    const normalizedScopes = scopes.map(normalizeScope);
    const overlayState: SessionListRowStoreState = { activeServerId };
    let previousOutput: readonly SessionListRowStateSnapshotScope[] | null = null;
    // Store notifications often replace the outer record while only one row
    // changes. Keep the existing priority projection with its scoped input,
    // and expire it at the runtime owner's boundary, including clock rewinds.
    const priorityByScope: Array<Readonly<{
        renderable: SessionListRenderableSession | undefined;
        evaluatedAtMs: number;
        validUntilMs: number | null;
        isPriority: boolean;
    }> | undefined> = [];

    return (state) => {
        const nowMs = nowServerMs();
        let nextOutput: SessionListRowStateSnapshotScope[] | null = null;
        for (let index = 0; index < normalizedScopes.length; index += 1) {
            const scope = normalizedScopes[index];
            if (!shouldReadActiveServerOverlay(overlayState, scope.serverId)) continue;
            const renderable = state.sessionListRenderables?.[scope.sessionId];
            let priority = priorityByScope[index];
            if (
                !priority
                || priority.renderable !== renderable
                || nowMs < priority.evaluatedAtMs
                || (priority.validUntilMs !== null && nowMs >= priority.validUntilMs)
            ) {
                priority = {
                    renderable,
                    evaluatedAtMs: nowMs,
                    validUntilMs: renderable
                        ? resolveNextSessionRuntimePresentationFreshnessAtMs(renderable, nowMs)
                        : null,
                    isPriority: isRuntimePriorityRenderable(renderable, nowMs),
                };
                priorityByScope[index] = priority;
            }
            if (!priority.isPriority) continue;
            if (nextOutput === null) nextOutput = [];
            nextOutput.push(scope);
        }

        const normalizedOutput = nextOutput ?? EMPTY_RUNTIME_PRIORITY_ROW_SCOPES;
        if (areScopeListsEqual(previousOutput, normalizedOutput)) {
            return previousOutput ?? EMPTY_RUNTIME_PRIORITY_ROW_SCOPES;
        }

        previousOutput = normalizedOutput;
        return normalizedOutput;
    };
}

export function createSessionListRowStoreStateSelector(
    scopes: readonly SessionListRowStateSnapshotScope[],
    activeServerId: string | null | undefined,
): (state: SessionListRowStoreStateSelectorInput) => SessionListRowStoreState {
    const normalizedScopes = scopes.map(normalizeScope);
    const overlayState: SessionListRowStoreState = { activeServerId };
    let previousSessions: readonly unknown[] | null = null;
    let previousRenderables: readonly unknown[] | null = null;
    let previousMessages: readonly unknown[] | null = null;
    let previousPending: readonly unknown[] | null = null;
    let previousAppearances: readonly (SessionAppearanceColor | null)[] | null = null;
    let previousOutput: SessionListRowStoreState | null = null;

    return (state) => {
        const nextSessions: unknown[] = [];
        const nextRenderables: unknown[] = [];
        const nextMessages: unknown[] = [];
        const nextPending: unknown[] = [];
        const nextAppearances: (SessionAppearanceColor | null)[] = [];
        const appearanceColorsBySessionKey: Record<string, SessionAppearanceColor | null> = {};
        const sessions: MutableSessionListRowStoreState['sessions'] = {};
        const sessionListRenderables: MutableSessionListRowStoreState['sessionListRenderables'] = {};
        const sessionMessages: MutableSessionListRowStoreState['sessionMessages'] = {};
        const sessionPending: MutableSessionListRowStoreState['sessionPending'] = {};

        let suppressedProgressRenderableUpdates = 0;
        // Server-adjusted clock: the reuse/suppression rules below compare
        // foreground progress and heartbeat anchors against server-clock
        // renderable timestamps.
        const nowMs = nowServerMs();
        for (let index = 0; index < normalizedScopes.length; index += 1) {
            const scope = normalizedScopes[index];
            const sessionId = scope.sessionId;
            const readActiveOverlay = shouldReadActiveServerOverlay(overlayState, scope.serverId);
            const rawRenderable = readActiveOverlay ? state.sessionListRenderables?.[sessionId] : undefined;
            const previousRenderable = previousRenderables?.[index] as SessionListRenderableSession | undefined;
            const renderable = shouldReusePreviousProgressRenderable({
                previous: previousRenderable,
                next: rawRenderable,
                nowMs,
            })
                ? previousRenderable
                : rawRenderable;
            if (renderable === previousRenderable && rawRenderable !== previousRenderable && rawRenderable !== undefined) {
                suppressedProgressRenderableUpdates += 1;
            }
            const session = readActiveOverlay && !renderable ? state.sessions?.[sessionId] : undefined;
            const messages = readActiveOverlay && !renderable ? state.sessionMessages?.[sessionId] : undefined;
            const pending = readActiveOverlay ? state.sessionPending?.[sessionId] : undefined;
            nextSessions.push(session);
            nextRenderables.push(renderable);
            nextMessages.push(messages);
            nextPending.push(pending);
            if (readActiveOverlay) {
                sessions[sessionId] = session;
                sessionListRenderables[sessionId] = renderable;
                sessionMessages[sessionId] = messages;
                sessionPending[sessionId] = pending;
            }
            const serverId = scope.serverId ?? activeServerId ?? '';
            const color = selectEffectiveSessionAppearanceColor(state, { serverId, sessionId, activeServerId,
                metadata: renderable?.metadata ?? session?.metadata ?? scope.metadata,
                active: renderable?.active ?? session?.active,
            });
            const previousColor = previousAppearances?.[index];
            const stableColor = areSessionAppearanceColorsEqual(previousColor, color) ? previousColor ?? null : color;
            nextAppearances.push(stableColor);
            appearanceColorsBySessionKey[`${serverId}:${sessionId}`] = stableColor;
        }

        if (suppressedProgressRenderableUpdates > 0) {
            recordRowStoreSelectorSuppressedTelemetry({
                renderables: suppressedProgressRenderableUpdates,
                scopedRows: normalizedScopes.length,
            });
        }

        if (
            previousOutput !== null
            && refsEqual(previousSessions, nextSessions)
            && refsEqual(previousRenderables, nextRenderables)
            && refsEqual(previousMessages, nextMessages)
            && refsEqual(previousPending, nextPending)
            && refsEqual(previousAppearances, nextAppearances)
        ) {
            return previousOutput;
        }

        recordRowStoreSelectorChangeTelemetry({
            scopedRows: normalizedScopes.length,
            initialOutput: previousOutput === null ? 1 : 0,
            changedSessions: countChangedRefs(previousSessions, nextSessions),
            changedRenderables: countChangedRefs(previousRenderables, nextRenderables),
            changedMessages: countChangedRefs(previousMessages, nextMessages),
            changedPending: countChangedRefs(previousPending, nextPending),
        });

        previousSessions = nextSessions;
        previousRenderables = nextRenderables;
        previousMessages = nextMessages;
        previousPending = nextPending;
        previousAppearances = nextAppearances;
        previousOutput = {
            activeServerId,
            sessions,
            sessionListRenderables,
            sessionMessages,
            sessionPending,
            appearanceColorsBySessionKey,
        };
        return previousOutput;
    };
}

function refsEqual(previous: readonly unknown[] | null, next: readonly unknown[]): boolean {
    if (previous === null) return false;
    if (previous.length !== next.length) return false;
    for (let index = 0; index < previous.length; index += 1) {
        if (previous[index] !== next[index]) return false;
    }
    return true;
}
