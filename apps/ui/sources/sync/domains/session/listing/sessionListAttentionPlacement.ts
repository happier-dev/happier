import type { SessionListBackgroundWorkAttentionMode } from './sessionListBackgroundWorkAttention';
import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { describeWorkStatusBucket } from '@/components/work/status/workStatusBuckets';
import { resolveWorkStatusTone, type WorkStatusPresentation } from '@/components/work/status/resolveWorkStatusTone';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import {
    resolveSessionAttentionStandingSource,
    resolveSessionReminderPresentation,
    type SessionAttentionStandingPolicy,
    type SessionAttentionStandingSource,
} from '@/sync/domains/session/organization/attentionStanding';

import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';
import type { SessionListRenderableSession } from './sessionListRenderable';
import {
    normalizeSessionListAttentionPlacementMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPlacementMode,
    type SessionListAttentionPlacementReason,
    type SessionListWorkingPlacementMode,
    type SessionListWorkingPlacementReason,
} from './sessionListAttentionPlacementTypes';
import { normalizeSessionViewerCompatibility } from '../readState/sessionViewer';

export const ATTENTION_PLACEMENT_GROUP_KEY_V1 = 'attention-promotion-v1';
export const WORKING_PLACEMENT_GROUP_KEY_V1 = 'working-placement-v1';
export const SESSION_LIST_WORKING_RETENTION_LIMIT_MS = 12 * 60 * 60 * 1000;

export type SessionListAttentionPlacementOptions = Readonly<{
    mode: SessionListAttentionPlacementMode;
    /** Archived corpus hosts opt in; active-library placement remains archive-excluding. */
    includeArchived?: boolean;
    /**
     * The user's Keep in Needs attention instructions, carried as the policy
     * itself rather than a resolved key set: an account default plus per-session
     * overrides, resolved per row by the single owner in the organization
     * domain.
     */
    standingPolicy?: SessionAttentionStandingPolicy;
}>;

export type SessionListWorkingPlacementOptions = Readonly<{
    mode: SessionListWorkingPlacementMode;
    retainSessionKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
}>;

export type SessionListAttentionPlacementResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

export type SessionListWorkingPlacementResult = Readonly<{
    workingItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

type SessionItem = Extract<SessionListIndexItem, { type: 'session' }>;
type PlacementReason = SessionListAttentionPlacementReason | 'working';

type PlacementCandidate<Reason extends PlacementReason> = Readonly<{
    item: SessionItem;
    key: string;
    reason: Reason;
    retainedWorking?: boolean;
    /**
     * Only meaningful for a 'standing' placement: true when the user asked for
     * THIS session to stay in the band, false when standing comes from the
     * account default. Explicit intent outranks "Hide inactive sessions"; a
     * blanket default must not silently disable that filter.
     */
    explicitStanding?: boolean;
}>;

function isRetainableWorkingSession(session: SessionListRenderableSession, nowMs: number): boolean {
    if (
        session.active !== true
        || session.presence !== 'online'
        || session.latestTurnStatus !== 'in_progress'
        || session.thinking === false
        || session.archivedAt != null
    ) {
        return false;
    }
    const retentionAnchor = resolveWorkingRetentionAnchor(session);
    return retentionAnchor !== null
        && retentionAnchor + SESSION_LIST_WORKING_RETENTION_LIMIT_MS > nowMs;
}

/** Placement consumes C1 admission; a failure or unread flag cannot invent a request. */
function resolveAttentionReason(
    session: SessionListRenderableSession,
    status: WorkStatusPresentation,
    standingSource: SessionAttentionStandingSource,
    dueReminder: boolean,
): SessionListAttentionPlacementReason | null {
    if (status.attentionType !== null && inboxItemViewV1(status.attentionType) === 'needs_you') {
        return status.attentionType === 'approval' ? 'permission_required' : 'action_required';
    }
    if (status.bucket === 'working' || standingSource === 'none') return null;
    // A due record is this viewer's explicit reminder, even before the server's
    // relevance projection catches up. A raw viewer flag cannot create it.
    if (dueReminder) return 'standing';
    // Keep the existing personal organization floor and its relevance/access boundary.
    const viewer = normalizeSessionViewerCompatibility(session);
    return viewer.kind === 'legacy_owner' || viewer.kind === 'current' && viewer.viewer.relevance.relevant
        ? 'standing' : null;
}

type SessionListPlacementProjection = Readonly<{
    attentionReason: SessionListAttentionPlacementReason | null;
    standingSource: SessionAttentionStandingSource;
    liveWorking: boolean;
}>;

function projectSessionListPlacement(params: Readonly<{
    session: SessionListRenderableSession;
    sessionKey: string;
    standingPolicy?: SessionAttentionStandingPolicy;
    nowMs: number;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
}>): SessionListPlacementProjection {
    const status = resolveWorkStatusTone({
        kind: 'session',
        facts: readSessionWorkStatusFacts(params.session, params.nowMs),
    });
    const liveWorking = status.bucket === 'working';
    const standingSource = params.standingPolicy
        ? resolveSessionAttentionStandingSource(params.standingPolicy, params.sessionKey, params.nowMs)
        : 'none';
    const dueReminder = resolveSessionReminderPresentation(
        params.standingPolicy?.overridesBySessionKey[params.sessionKey], params.nowMs,
    )?.state === 'due';
    const attentionReason = resolveAttentionReason(
        params.session,
        status,
        standingSource,
        dueReminder,
    );
    return {
        attentionReason: attentionReason === 'standing' && dueReminder ? 'reminder' : attentionReason,
        standingSource,
        liveWorking,
    };
}

function resolveWorkingRetentionAnchor(session: SessionListRenderableSession): number | null {
    return maxNormalizedTimestamp([
        session.latestTurnStatusObservedAt,
        session.thinkingAt,
        session.activeAt,
        session.optimisticThinkingAt,
    ]);
}

function maxNormalizedTimestamp(values: ReadonlyArray<number | null | undefined>): number | null {
    let max: number | null = null;
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
        const normalized = Math.trunc(value);
        max = max === null ? normalized : Math.max(max, normalized);
    }
    return max;
}

function normalizeRetainedKeys(retained: ReadonlySet<string> | ReadonlyArray<string> | null | undefined): ReadonlySet<string> {
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

function createAttentionCandidate(params: Readonly<{
    item: SessionItem;
    key: string;
    projection: SessionListPlacementProjection;
}>): PlacementCandidate<SessionListAttentionPlacementReason> | null {
    const reason = params.projection.attentionReason;
    if (!reason) return null;
    return {
        item: params.item,
        key: params.key,
        reason,
        explicitStanding: reason === 'standing' && params.projection.standingSource === 'override',
    };
}

function createWorkingCandidate(params: Readonly<{
    item: SessionItem;
    row: SessionListRenderableSession;
    key: string;
    projection: SessionListPlacementProjection;
    retainedKeys: ReadonlySet<string>;
    nowMs: number;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
}>): PlacementCandidate<'working'> | null {
    if (params.item.archivedAt != null || params.row.archivedAt != null) return null;
    if (params.projection.attentionReason) return null;
    if (
        !params.projection.liveWorking
        && !(params.retainedKeys.has(params.key) && isRetainableWorkingSession(params.row, params.nowMs))
    ) {
        return null;
    }
    return {
        item: params.item,
        key: params.key,
        reason: 'working',
        retainedWorking: !params.projection.liveWorking,
    };
}

/**
 * Whether placement exempts the row from "Hide inactive sessions". Every earned
 * attention reason does: the session itself is asking for the user. Standing
 * only does when the user asked for THIS session — standing derived from the
 * account default would otherwise turn that filter into a no-op for every quiet
 * session. Placement never CLEARS an exemption the row already carries for its
 * own reasons, so the flag is spread in rather than assigned.
 */
function keepAttentionCandidateVisibleWhenInactive(
    candidate: PlacementCandidate<SessionListAttentionPlacementReason>,
): boolean {
    return candidate.reason !== 'standing' || candidate.explicitStanding === true;
}

function createGlobalAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPlacementReason>): SessionItem {
    return {
        ...candidate.item,
        occurrenceRole: 'needsYou',
        reportsDepth: undefined,
        reportsParentContext: undefined,
        reportsParent: undefined,
        reportsDefaultCollapsed: undefined,
        reportsCollapsed: undefined,
        folderDepth: undefined,
        groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'attention',
        attentionPlacementReason: candidate.reason,
        workingPlacementReason: undefined,
        variant: 'default',
        ...(keepAttentionCandidateVisibleWhenInactive(candidate) ? { keepVisibleWhenInactive: true } : {}),
    };
}

function resolveWorkingPlacementReason(candidate: PlacementCandidate<'working'>): SessionListWorkingPlacementReason {
    // Retained placement keeps the session in the working group after its
    // live signals went stale; rows use the distinct reason to render a
    // paused indicator instead of pretending live activity.
    return candidate.retainedWorking === true ? 'working-retained' : 'working';
}

function createGlobalWorkingSessionItem(candidate: PlacementCandidate<'working'>): SessionItem {
    const workingPlacementReason = resolveWorkingPlacementReason(candidate);
    return {
        ...candidate.item,
        occurrenceRole: 'working',
        reportsDepth: undefined,
        reportsParentContext: undefined,
        reportsParent: undefined,
        reportsDefaultCollapsed: undefined,
        reportsCollapsed: undefined,
        folderDepth: undefined,
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'working',
        attentionPlacementReason: undefined,
        workingPlacementReason,
        variant: 'default',
        keepVisibleWhenInactive: true,
    };
}

export type SessionListGlobalPlacementsResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    workingItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    attentionPromotedCount: number;
    workingPromotedCount: number;
    attentionEligibleCount: number;
    workingEligibleCount: number;
}>;

export function buildSessionListGlobalPlacements(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    placement?: 'both' | 'top' | 'inPlace';
    previousPresentedIndex?: ReadonlyArray<SessionListIndexItem> | null;
    holdMembership?: boolean;
    /** P6 supplies authorized out-of-space Needs-you entities, never Working. */
    supplementalNeedsYouSessionKeys?: ReadonlySet<string>;
    attentionOptions: SessionListAttentionPlacementOptions | undefined;
    workingOptions: SessionListWorkingPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
}>): SessionListGlobalPlacementsResult | null {
    if (params.source.length === 0) return null;
    if (params.placement === 'inPlace') return null;

    const attentionEnabled = normalizeSessionListAttentionPlacementMode(params.attentionOptions?.mode) === 'global'
        && params.attentionOptions != null;
    const workingEnabled = normalizeSessionListWorkingPlacementMode(params.workingOptions?.mode) === 'global'
        && params.workingOptions != null;
    if (!attentionEnabled && !workingEnabled) return null;

    const retainedWorkingSource = workingEnabled ? params.workingOptions?.retainSessionKeys : undefined;
    const retainedWorkingKeys = normalizeRetainedKeys(retainedWorkingSource);
    const attentionCandidates: Array<PlacementCandidate<SessionListAttentionPlacementReason>> = [];
    const workingCandidates: Array<PlacementCandidate<'working'>> = [];
    const sourceByKey = new Map<string, SessionItem>();

    params.source.forEach((item) => {
        if (item.type !== 'session') return;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (!key) return;
        const row = params.resolveSessionRow(item.serverId, item.sessionId);
        if (!row) return;
        if (params.attentionOptions?.includeArchived !== true && (item.archivedAt != null || row.archivedAt != null)) return;
        sourceByKey.set(key, item);
        const projection = projectSessionListPlacement({
            session: row,
            sessionKey: key,
            standingPolicy: attentionEnabled ? params.attentionOptions?.standingPolicy : undefined,
            nowMs: params.nowMs,
            backgroundWorkAttentionMode: params.backgroundWorkAttentionMode,
        });

        if (
            attentionEnabled
            && (params.attentionOptions?.includeArchived === true || (item.archivedAt == null && row.archivedAt == null))
        ) {
            const attentionCandidate = createAttentionCandidate({
                item,
                key,
                projection,
            });
            if (attentionCandidate) {
                attentionCandidates.push(attentionCandidate);
                return;
            }
        }

        if (!workingEnabled || params.supplementalNeedsYouSessionKeys?.has(key)) return;
        const workingCandidate = createWorkingCandidate({
            item,
            row,
            key,
            projection,
            retainedKeys: retainedWorkingKeys,
            nowMs: params.nowMs,
            backgroundWorkAttentionMode: params.backgroundWorkAttentionMode,
        });
        if (!workingCandidate) return;
        workingCandidates.push(workingCandidate);
    });

    // The previous rendered index is the sole presentation sequence. Live facts
    // determine eligibility; neither severity nor an activity timestamp ranks it.
    const attentionByKey = new Map(attentionCandidates.map(candidate => [candidate.key, candidate]));
    const workingByKey = new Map(workingCandidates.map(candidate => [candidate.key, candidate]));
    const presentedAttention: SessionItem[] = [];
    const presentedWorking: SessionItem[] = [];
    const presentedKeys = new Set<string>();
    for (const previous of params.previousPresentedIndex ?? []) {
        if (previous.type !== 'session') continue;
        const band = previous.occurrenceRole === 'needsYou' || previous.groupKind === 'attention' ? 'needsYou'
            : previous.occurrenceRole === 'working' || previous.groupKind === 'working' ? 'working' : null;
        if (!band) continue;
        const key = normalizeSessionListKeyParts(previous.serverId, previous.sessionId, previous.keyParts).sessionKey;
        if (!key) continue;
        const source = sourceByKey.get(key);
        // The authorized admitted source always wins over presentation hold.
        if (!source || presentedKeys.has(key)) continue;
        const attention = attentionByKey.get(key);
        const working = workingByKey.get(key);
        if (!params.holdMembership && (band === 'needsYou' ? !attention : !working)) continue;
        presentedKeys.add(key);
        const live = attention ? createGlobalAttentionSessionItem(attention)
            : working ? createGlobalWorkingSessionItem(working) : source;
        const item: SessionItem = {
            ...live,
            occurrenceRole: band,
            groupKey: band === 'needsYou' ? ATTENTION_PLACEMENT_GROUP_KEY_V1 : WORKING_PLACEMENT_GROUP_KEY_V1,
            groupKind: band === 'needsYou' ? 'attention' : 'working',
            reportsDepth: undefined,
            reportsParentContext: undefined,
            reportsParent: undefined,
            reportsDefaultCollapsed: undefined,
            reportsCollapsed: undefined,
            folderDepth: undefined,
            keepVisibleWhenInactive: true,
        };
        (band === 'needsYou' ? presentedAttention : presentedWorking).push(item);
    }
    if (!params.holdMembership) {
        for (const candidate of attentionCandidates) {
            if (presentedKeys.has(candidate.key)) continue;
            presentedKeys.add(candidate.key);
            presentedAttention.push(createGlobalAttentionSessionItem(candidate));
        }
        for (const candidate of workingCandidates) {
            if (presentedKeys.has(candidate.key)) continue;
            presentedKeys.add(candidate.key);
            presentedWorking.push(createGlobalWorkingSessionItem(candidate));
        }
    }
    // The first outside qualifier may arrive while the list is held with no
    // existing shelf. Its live eligibility must not make it an ordinary base.
    let hasSupplementalSource = false;
    if (params.supplementalNeedsYouSessionKeys) {
        for (const key of params.supplementalNeedsYouSessionKeys) {
            if (!sourceByKey.has(key)) continue;
            hasSupplementalSource = true;
            break;
        }
    }
    if (presentedAttention.length === 0 && presentedWorking.length === 0 && !hasSupplementalSource) return null;

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
        if (key && params.supplementalNeedsYouSessionKeys?.has(key)) return false;
        if (params.placement !== 'top') return true;
        if (item.reportsParent === true) return true;
        return !key || !presentedKeys.has(key);
    });

    return {
        attentionItems: presentedAttention.length > 0
            ? [
                {
                    type: 'header',
                    title: describeWorkStatusBucket('needs_you'),
                    headerKind: 'attention',
                    groupKey: ATTENTION_PLACEMENT_GROUP_KEY_V1,
                    eligibleCount: attentionCandidates.length,
                },
                ...presentedAttention,
            ]
            : [],
        workingItems: presentedWorking.length > 0
            ? [
                { ...createWorkingPlacementHeader(), eligibleCount: workingCandidates.length },
                ...presentedWorking,
            ]
            : [],
        remainder,
        attentionPromotedCount: presentedAttention.length,
        workingPromotedCount: presentedWorking.length,
        attentionEligibleCount: attentionCandidates.length,
        workingEligibleCount: workingCandidates.length,
    };
}

export function buildSessionListAttentionPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
}>): SessionListAttentionPlacementResult | null {
    if (normalizeSessionListAttentionPlacementMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }

    const result = buildSessionListGlobalPlacements({
        source: params.source,
        placement: 'top',
        attentionOptions: params.options,
        workingOptions: undefined,
        resolveSessionRow: params.resolveSessionRow,
        nowMs: params.nowMs,
        backgroundWorkAttentionMode: params.backgroundWorkAttentionMode,
    });
    return result && result.attentionPromotedCount > 0
        ? {
            attentionItems: result.attentionItems,
            remainder: result.remainder,
            promotedCount: result.attentionPromotedCount,
        }
        : null;
}

function createWorkingPlacementHeader(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: describeWorkStatusBucket('working'),
        headerKind: 'working',
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
    };
}

export function buildSessionListWorkingPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListWorkingPlacementOptions | undefined;
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null;
    nowMs: number;
    backgroundWorkAttentionMode?: SessionListBackgroundWorkAttentionMode;
}>): SessionListWorkingPlacementResult | null {
    if (normalizeSessionListWorkingPlacementMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }

    const result = buildSessionListGlobalPlacements({
        source: params.source,
        placement: 'top',
        attentionOptions: undefined,
        workingOptions: params.options,
        resolveSessionRow: params.resolveSessionRow,
        nowMs: params.nowMs,
        backgroundWorkAttentionMode: params.backgroundWorkAttentionMode,
    });
    return result && result.workingPromotedCount > 0
        ? {
            workingItems: result.workingItems,
            remainder: result.remainder,
            promotedCount: result.workingPromotedCount,
        }
        : null;
}

export { normalizeSessionListAttentionPlacementMode, normalizeSessionListWorkingPlacementMode };
export type {
    SessionListAttentionPlacementMode,
    SessionListAttentionPlacementReason,
    SessionListWorkingPlacementMode,
};
