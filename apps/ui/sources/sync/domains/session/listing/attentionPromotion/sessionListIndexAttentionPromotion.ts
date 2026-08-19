import { t } from '@/text';

import type { SessionAttentionStandingPolicy } from '../../organization/attentionStanding';
import type { SessionListIndexItem } from '../sessionListIndex';
import { resolveSessionRowForIndexItem, type ResolveSessionListIndexRow } from '../sessionListIndexSessionRows';
import type { SessionListRenderableSession } from '../sessionListRenderable';
import {
    projectSessionListPlacement,
    resolveSessionListPlacementTimestampForReason,
} from '../placement/sessionListPlacementProjection';
import {
    normalizeSessionListPlacementKey,
    normalizeSessionListWorkingRetentionKeys,
    type SessionListWorkingRetentionKeySource,
} from '../placement/sessionListWorkingRetention';
import {
    ATTENTION_PROMOTION_GROUP_KEY_V1,
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPromotionOptions,
    type SessionListAttentionPromotionReason,
    type SessionListRetainedAttentionPlacement,
    type SessionListWorkingPlacementOptions,
} from './sessionListAttentionPromotion';

export const WORKING_PLACEMENT_GROUP_KEY_V1 = 'working-placement-v1';

type SessionIndexItem = Extract<SessionListIndexItem, { type: 'session' }>;
type WorkingPlacementCandidateReason = 'working';
type PlacementReason = SessionListAttentionPromotionReason | WorkingPlacementCandidateReason;

type PlacementCandidate<Reason extends PlacementReason> = Readonly<{
    item: SessionIndexItem;
    key: string;
    row: SessionListRenderableSession;
    reason: Reason;
    timestamp: number;
    originalIndex: number;
    retainedIndex: number | null;
    retainedWorking?: boolean;
    explicitStanding?: boolean;
}>;

type SessionRunEntry = Readonly<{
    item: SessionIndexItem;
    originalIndex: number;
}>;

const EMPTY_RETAINED_ATTENTION_REASONS: ReadonlyMap<string, SessionListAttentionPromotionReason> = new Map();

type PlacementLane<Reason extends PlacementReason> = Readonly<{
    resolveCandidate: (params: Readonly<{
        item: SessionIndexItem;
        originalIndex: number;
        retainedKeys: ReadonlySet<string>;
        retainedKeyRanks: ReadonlyMap<string, number>;
        retainedAttentionReasons: ReadonlyMap<string, SessionListAttentionPromotionReason>;
        retainedWorkingKeys: ReadonlySet<string>;
        standingPolicy: SessionAttentionStandingPolicy | undefined;
        resolveSessionRow: ResolveSessionListIndexRow;
        nowMs: number;
    }>) => PlacementCandidate<Reason> | null;
    compareCandidates: (left: PlacementCandidate<Reason>, right: PlacementCandidate<Reason>) => number;
    createGlobalSessionItem: (candidate: PlacementCandidate<Reason>) => SessionIndexItem;
    createWithinGroupSessionItem: (candidate: PlacementCandidate<Reason>) => SessionIndexItem;
}>;

const ATTENTION_REASON_PRIORITY: Readonly<Record<SessionListAttentionPromotionReason, number>> = {
    action_required: 0,
    permission_required: 1,
    failed: 2,
    ready: 3,
    unread: 4,
    // Standing is the floor of the band: it only reaches sessions whose own
    // signals place them nowhere, so it always sorts behind every earned reason.
    standing: 5,
};

function normalizeRetainedKeys(retained: ReadonlySet<string> | ReadonlyArray<string> | null | undefined): ReadonlySet<string> {
    if (!retained) return new Set();
    if (retained instanceof Set) return retained;
    return new Set(retained);
}

function buildRetainedKeyRanks(retained: ReadonlySet<string> | ReadonlyArray<string> | null | undefined): ReadonlyMap<string, number> {
    if (!retained) return new Map();
    const ranks = new Map<string, number>();
    let index = 0;
    for (const key of retained) {
        const normalized = typeof key === 'string' ? key.trim() : '';
        if (normalized && !ranks.has(normalized)) {
            ranks.set(normalized, index);
            index += 1;
        }
    }
    return ranks;
}

function normalizeRetainedAttentionPlacements(
    placements: ReadonlyArray<SessionListRetainedAttentionPlacement> | null | undefined,
): Readonly<{
    keys: ReadonlyArray<string>;
    reasons: ReadonlyMap<string, SessionListAttentionPromotionReason>;
}> {
    if (!placements || placements.length === 0) {
        return { keys: [], reasons: EMPTY_RETAINED_ATTENTION_REASONS };
    }
    const keys: string[] = [];
    const reasons = new Map<string, SessionListAttentionPromotionReason>();
    for (const placement of placements) {
        const key = placement.key.trim();
        if (!key || reasons.has(key)) continue;
        keys.push(key);
        reasons.set(key, placement.reason);
    }
    return { keys, reasons };
}

function compareAttentionCandidates(
    left: PlacementCandidate<SessionListAttentionPromotionReason>,
    right: PlacementCandidate<SessionListAttentionPromotionReason>,
): number {
    const priorityDelta = ATTENTION_REASON_PRIORITY[left.reason] - ATTENTION_REASON_PRIORITY[right.reason];
    if (priorityDelta !== 0) return priorityDelta;
    return comparePlacementCandidatesByTimestamp(left, right);
}

function comparePlacementCandidatesByTimestamp<Reason extends PlacementReason>(
    left: PlacementCandidate<Reason>,
    right: PlacementCandidate<Reason>,
): number {
    if (left.retainedIndex !== null && right.retainedIndex !== null && left.retainedIndex !== right.retainedIndex) {
        return left.retainedIndex - right.retainedIndex;
    }
    if (right.timestamp !== left.timestamp) return right.timestamp - left.timestamp;
    if (left.originalIndex !== right.originalIndex) return left.originalIndex - right.originalIndex;
    return left.key.localeCompare(right.key);
}

function resolveAttentionCandidate(params: Readonly<{
    item: SessionIndexItem;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    retainedAttentionReasons: ReadonlyMap<string, SessionListAttentionPromotionReason>;
    retainedWorkingKeys: ReadonlySet<string>;
    standingPolicy: SessionAttentionStandingPolicy | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): PlacementCandidate<SessionListAttentionPromotionReason> | null {
    const key = normalizeSessionListPlacementKey(params.item.serverId, params.item.sessionId);
    if (!key) return null;
    const row = resolveSessionRowForIndexItem(params.item, params.resolveSessionRow);
    if (!row || row.archivedAt != null) return null;
    const placement = projectSessionListPlacement({
        session: row,
        sessionKey: key,
        retainedWorkingSessionKeys: params.retainedWorkingKeys,
        standingPolicy: params.standingPolicy,
        nowMs: params.nowMs,
    });
    const reason = placement.kind === 'none'
        || placement.kind === 'working'
        ? null
        : placement.kind;
    const retainedReason = params.retainedAttentionReasons.get(key) ?? null;
    if (!reason && !retainedReason) return null;
    if (!reason && placement.kind === 'working') return null;

    const resolvedReason = reason ?? retainedReason;
    if (!resolvedReason) return null;
    return {
        item: params.item,
        key,
        row,
        reason: resolvedReason,
        timestamp: placement.kind === resolvedReason && placement.timestamp !== null
            ? placement.timestamp
            : resolveSessionListPlacementTimestampForReason(row, resolvedReason) ?? 0,
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(key) ?? null,
        explicitStanding: placement.kind === 'standing' && placement.explicitStanding,
    };
}

function resolveWorkingCandidate(params: Readonly<{
    item: SessionIndexItem;
    originalIndex: number;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    retainedAttentionReasons: ReadonlyMap<string, SessionListAttentionPromotionReason>;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): PlacementCandidate<WorkingPlacementCandidateReason> | null {
    const key = normalizeSessionListPlacementKey(params.item.serverId, params.item.sessionId);
    if (!key) return null;
    const row = resolveSessionRowForIndexItem(params.item, params.resolveSessionRow);
    if (!row || row.archivedAt != null) return null;
    const placement = projectSessionListPlacement({
        session: row,
        sessionKey: key,
        retainedWorkingSessionKeys: params.retainedKeys,
        nowMs: params.nowMs,
    });
    if (placement.kind !== 'working') return null;
    return {
        item: params.item,
        key,
        row,
        reason: placement.kind,
        timestamp: 0,
        originalIndex: params.originalIndex,
        retainedIndex: params.retainedKeyRanks.get(key) ?? null,
        retainedWorking: placement.retainedWorking,
    };
}

/**
 * Whether promotion exempts the row from "Hide inactive sessions". Every
 * earned attention reason does: the session itself is asking for the user.
 * Standing only does when the user asked for THIS session — standing derived
 * from the account default would otherwise turn that filter into a no-op for
 * every quiet session. Promotion never clears an exemption the row already
 * carries for its own reasons (a stopped session held visible, say).
 */
function keepAttentionCandidateVisibleWhenInactive(candidate: PlacementCandidate<SessionListAttentionPromotionReason>): boolean {
    return candidate.reason !== 'standing' || candidate.explicitStanding === true;
}

function createGlobalAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPromotionReason>): SessionIndexItem {
    return {
        ...candidate.item,
        groupKey: ATTENTION_PROMOTION_GROUP_KEY_V1,
        groupKind: 'attention',
        ...(keepAttentionCandidateVisibleWhenInactive(candidate) ? { keepVisibleWhenInactive: true } : {}),
        attentionPromotionReason: candidate.reason,
        workingPlacementReason: undefined,
        variant: 'default',
    };
}

function createWithinGroupAttentionSessionItem(candidate: PlacementCandidate<SessionListAttentionPromotionReason>): SessionIndexItem {
    return {
        ...candidate.item,
        ...(keepAttentionCandidateVisibleWhenInactive(candidate) ? { keepVisibleWhenInactive: true } : {}),
        attentionPromotionReason: candidate.reason,
        workingPlacementReason: undefined,
    };
}

function resolveWorkingPlacementReason(candidate: PlacementCandidate<WorkingPlacementCandidateReason>): 'working' | 'working-retained' {
    // Retained placement keeps the session in the working group after its
    // live signals went stale; rows use the distinct reason to render a
    // paused indicator instead of pretending live activity.
    return candidate.retainedWorking === true ? 'working-retained' : 'working';
}

function createGlobalWorkingSessionItem(candidate: PlacementCandidate<WorkingPlacementCandidateReason>): SessionIndexItem {
    return {
        ...candidate.item,
        groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        groupKind: 'working',
        keepVisibleWhenInactive: true,
        attentionPromotionReason: undefined,
        workingPlacementReason: resolveWorkingPlacementReason(candidate),
        variant: 'default',
    };
}

function createWithinGroupWorkingSessionItem(candidate: PlacementCandidate<WorkingPlacementCandidateReason>): SessionIndexItem {
    return {
        ...candidate.item,
        keepVisibleWhenInactive: true,
        attentionPromotionReason: undefined,
        workingPlacementReason: resolveWorkingPlacementReason(candidate),
    };
}

const ATTENTION_LANE: PlacementLane<SessionListAttentionPromotionReason> = {
    resolveCandidate: resolveAttentionCandidate,
    compareCandidates: compareAttentionCandidates,
    createGlobalSessionItem: createGlobalAttentionSessionItem,
    createWithinGroupSessionItem: createWithinGroupAttentionSessionItem,
};

const WORKING_LANE: PlacementLane<WorkingPlacementCandidateReason> = {
    resolveCandidate: resolveWorkingCandidate,
    compareCandidates: comparePlacementCandidatesByTimestamp,
    createGlobalSessionItem: createGlobalWorkingSessionItem,
    createWithinGroupSessionItem: createWithinGroupWorkingSessionItem,
};

export type SessionListIndexPlacementResult = Readonly<{
    placementItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
    candidates: ReadonlyArray<PlacementCandidate<PlacementReason>>;
}>;

export type SessionListIndexAttentionPromotionResult = Readonly<{
    attentionItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

export type SessionListIndexWorkingPlacementResult = Readonly<{
    workingItems: SessionListIndexItem[];
    remainder: SessionListIndexItem[];
    promotedCount: number;
}>;

function buildSessionListIndexGlobalPlacement<Reason extends PlacementReason>(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    retainedKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
    retainedAttentionReasons?: ReadonlyMap<string, SessionListAttentionPromotionReason>;
    retainedWorkingKeys?: SessionListWorkingRetentionKeySource;
    standingPolicy?: SessionAttentionStandingPolicy;
    resolveSessionRow: ResolveSessionListIndexRow;
    lane: PlacementLane<Reason>;
    header: Extract<SessionListIndexItem, { type: 'header' }>;
    nowMs: number;
}>): SessionListIndexPlacementResult | null {
    if (params.source.length === 0) return null;

    const retainedKeys = normalizeRetainedKeys(params.retainedKeys);
    const retainedKeyRanks = buildRetainedKeyRanks(params.retainedKeys);
    const retainedWorkingKeys = normalizeSessionListWorkingRetentionKeys(params.retainedWorkingKeys);
    const promoted: Array<PlacementCandidate<Reason>> = [];
    const promotedKeySet = new Set<string>();

    params.source.forEach((item, originalIndex) => {
        if (item.type !== 'session') return;
        const candidate = params.lane.resolveCandidate({
            item,
            originalIndex,
            retainedKeys,
            retainedKeyRanks,
            retainedAttentionReasons: params.retainedAttentionReasons ?? EMPTY_RETAINED_ATTENTION_REASONS,
            retainedWorkingKeys,
            standingPolicy: params.standingPolicy,
            resolveSessionRow: params.resolveSessionRow,
            nowMs: params.nowMs,
        });
        if (!candidate) return;
        promoted.push(candidate);
        promotedKeySet.add(candidate.key);
    });

    if (promoted.length === 0) {
        return null;
    }

    promoted.sort(params.lane.compareCandidates);

    const remainder = params.source.filter((item) => {
        if (item.type !== 'session') return true;
        const key = normalizeSessionListPlacementKey(item.serverId, item.sessionId);
        return !key || !promotedKeySet.has(key);
    });

    return {
        placementItems: [
            params.header,
            ...promoted.map(params.lane.createGlobalSessionItem),
        ],
        remainder,
        promotedCount: promoted.length,
        candidates: promoted,
    };
}

function reorderSessionRunWithinGroup<Reason extends PlacementReason>(params: Readonly<{
    entries: ReadonlyArray<SessionRunEntry>;
    retainedKeys: ReadonlySet<string>;
    retainedKeyRanks: ReadonlyMap<string, number>;
    retainedAttentionReasons: ReadonlyMap<string, SessionListAttentionPromotionReason>;
    retainedWorkingKeys: ReadonlySet<string>;
    standingPolicy: SessionAttentionStandingPolicy | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
    lane: PlacementLane<Reason>;
    nowMs: number;
}>): Readonly<{
    items: SessionListIndexItem[];
    changed: boolean;
}> {
    const candidates = new Map<SessionIndexItem, PlacementCandidate<Reason>>();
    for (const entry of params.entries) {
        const candidate = params.lane.resolveCandidate({
            item: entry.item,
            originalIndex: entry.originalIndex,
            retainedKeys: params.retainedKeys,
            retainedKeyRanks: params.retainedKeyRanks,
            retainedAttentionReasons: params.retainedAttentionReasons,
            retainedWorkingKeys: params.retainedWorkingKeys,
            standingPolicy: params.standingPolicy,
            resolveSessionRow: params.resolveSessionRow,
            nowMs: params.nowMs,
        });
        if (candidate) candidates.set(entry.item, candidate);
    }

    if (candidates.size === 0) {
        return {
            items: params.entries.map((entry) => entry.item),
            changed: false,
        };
    }

    const promoted = [...candidates.values()].sort(params.lane.compareCandidates);
    const remainder = params.entries
        .map((entry) => entry.item)
        .filter((item) => !candidates.has(item));
    const items = [
        ...promoted.map(params.lane.createWithinGroupSessionItem),
        ...remainder,
    ];
    const original = params.entries.map((entry) => entry.item);
    const changed = items.length !== original.length || items.some((item, index) => item !== original[index]);
    return { items, changed };
}

function applySessionListIndexPlacementWithinGroups<Reason extends PlacementReason>(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    retainedKeys?: ReadonlySet<string> | ReadonlyArray<string> | null;
    retainedAttentionReasons?: ReadonlyMap<string, SessionListAttentionPromotionReason>;
    retainedWorkingKeys?: SessionListWorkingRetentionKeySource;
    standingPolicy?: SessionAttentionStandingPolicy;
    resolveSessionRow: ResolveSessionListIndexRow;
    lane: PlacementLane<Reason>;
    nowMs: number;
}>): SessionListIndexItem[] {
    if (params.source.length === 0) {
        return params.source as SessionListIndexItem[];
    }

    const retainedKeys = normalizeRetainedKeys(params.retainedKeys);
    const retainedKeyRanks = buildRetainedKeyRanks(params.retainedKeys);
    const retainedWorkingKeys = normalizeSessionListWorkingRetentionKeys(params.retainedWorkingKeys);
    const out: SessionListIndexItem[] = [];
    let run: SessionRunEntry[] = [];
    let changed = false;

    const flushRun = () => {
        if (run.length === 0) return;
        const reordered = reorderSessionRunWithinGroup({
            entries: run,
            retainedKeys,
            retainedKeyRanks,
            retainedAttentionReasons: params.retainedAttentionReasons ?? EMPTY_RETAINED_ATTENTION_REASONS,
            retainedWorkingKeys,
            standingPolicy: params.standingPolicy,
            resolveSessionRow: params.resolveSessionRow,
            lane: params.lane,
            nowMs: params.nowMs,
        });
        out.push(...reordered.items);
        changed = changed || reordered.changed;
        run = [];
    };

    params.source.forEach((item, originalIndex) => {
        if (item.type === 'session') {
            run.push({ item, originalIndex });
            return;
        }
        flushRun();
        out.push(item);
    });
    flushRun();

    return changed ? out : params.source as SessionListIndexItem[];
}

export function buildSessionListIndexAttentionPromotion(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPromotionOptions | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): SessionListIndexAttentionPromotionResult | null {
    if (normalizeSessionListAttentionPromotionMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }
    const retained = normalizeRetainedAttentionPlacements(params.options.retainedPlacements);

    const result = buildSessionListIndexGlobalPlacement({
        source: params.source,
        retainedKeys: retained.keys,
        retainedAttentionReasons: retained.reasons,
        standingPolicy: params.options.standingPolicy,
        resolveSessionRow: params.resolveSessionRow,
        lane: ATTENTION_LANE,
        nowMs: params.nowMs,
        header: {
            type: 'header',
            title: t('sessionsList.attentionSectionTitle'),
            headerKind: 'attention',
            groupKey: ATTENTION_PROMOTION_GROUP_KEY_V1,
        },
    });
    return result
        ? {
            attentionItems: result.placementItems,
            remainder: result.remainder,
            promotedCount: result.promotedCount,
        }
        : null;
}

export function buildSessionListIndexWorkingPlacement(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListWorkingPlacementOptions | undefined;
    retainedKeys?: SessionListWorkingRetentionKeySource;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): SessionListIndexWorkingPlacementResult | null {
    if (normalizeSessionListWorkingPlacementMode(params.options?.mode) !== 'global' || !params.options) {
        return null;
    }

    const result = buildSessionListIndexGlobalPlacement({
        source: params.source,
        retainedKeys: params.retainedKeys,
        resolveSessionRow: params.resolveSessionRow,
        lane: WORKING_LANE,
        nowMs: params.nowMs,
        header: {
            type: 'header',
            title: t('sessionsList.workingSectionTitle'),
            headerKind: 'working',
            groupKey: WORKING_PLACEMENT_GROUP_KEY_V1,
        },
    });
    return result
        ? {
            workingItems: result.placementItems,
            remainder: result.remainder,
            promotedCount: result.promotedCount,
        }
        : null;
}

export function applySessionListIndexAttentionPromotionWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListAttentionPromotionOptions | undefined;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): SessionListIndexItem[] {
    if (normalizeSessionListAttentionPromotionMode(params.options?.mode) !== 'withinGroups' || !params.options) {
        return params.source as SessionListIndexItem[];
    }
    const retained = normalizeRetainedAttentionPlacements(params.options.retainedPlacements);

    return applySessionListIndexPlacementWithinGroups({
        source: params.source,
        retainedKeys: retained.keys,
        retainedAttentionReasons: retained.reasons,
        standingPolicy: params.options.standingPolicy,
        resolveSessionRow: params.resolveSessionRow,
        lane: ATTENTION_LANE,
        nowMs: params.nowMs,
    });
}

export function applySessionListIndexWorkingPlacementWithinGroups(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    options: SessionListWorkingPlacementOptions | undefined;
    retainedKeys?: SessionListWorkingRetentionKeySource;
    resolveSessionRow: ResolveSessionListIndexRow;
    nowMs: number;
}>): SessionListIndexItem[] {
    if (normalizeSessionListWorkingPlacementMode(params.options?.mode) !== 'withinGroups' || !params.options) {
        return params.source as SessionListIndexItem[];
    }

    return applySessionListIndexPlacementWithinGroups({
        source: params.source,
        retainedKeys: params.retainedKeys,
        resolveSessionRow: params.resolveSessionRow,
        lane: WORKING_LANE,
        nowMs: params.nowMs,
    });
}
