import { SessionWorkStateStatusReasonV1Schema } from '@happier-dev/protocol';

import type {
    SessionWorkStateGoalCapabilities,
    SessionWorkStateItem,
    SessionWorkStateKind,
    SessionWorkStateOrigin,
    SessionWorkStateSnapshot,
    SessionWorkStateStatus,
    SessionWorkStateStatusReason,
} from './sessionWorkStateTypes';

const VALID_KINDS: ReadonlySet<string> = new Set(['goal', 'task', 'todo']);
const VALID_ORIGINS: ReadonlySet<string> = new Set(['vendor', 'happier', 'derived']);
const VALID_STATUSES: ReadonlySet<string> = new Set([
    'pending',
    'active',
    'paused',
    'blocked',
    'complete',
    'cancelled',
    'unknown',
]);

type WorkStateBadgeTranslationKey =
    | 'session.workState.badge.goal'
    | 'session.workState.badge.goalPaused'
    | 'session.workState.badge.goalBlocked'
    | 'session.workState.badge.goalBudgetLimited'
    | 'session.workState.badge.goalComplete'
    | 'session.workState.badge.item'
    | 'session.workState.goal.title';

type Translate = (key: WorkStateBadgeTranslationKey, params?: { title: string }) => string;
type ReadItemResult =
    | Readonly<{ type: 'item'; item: SessionWorkStateItem }>
    | Readonly<{ type: 'ignored' }>
    | Readonly<{ type: 'invalid' }>;

export const SESSION_WORK_STATE_STATUS_BADGE_KEY = 'work-state';

export type SessionWorkStateStatusBadgePresentation = Readonly<{
    itemKind: SessionWorkStateKind;
    label: string;
    tone: 'neutral' | 'active' | 'paused' | 'warning' | 'complete';
    emphasis: 'quiet' | 'prominent';
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
    const number = readNumber(value);
    return number !== null && number >= 0 ? number : null;
}

function readStatusReason(value: unknown): SessionWorkStateStatusReason | null {
    const parsed = SessionWorkStateStatusReasonV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function readGoalCapabilities(value: unknown): SessionWorkStateGoalCapabilities | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const capabilities: { canEdit?: boolean; canStop?: boolean; canClear?: boolean } = {};
    if (typeof raw.canEdit === 'boolean') capabilities.canEdit = raw.canEdit;
    if (typeof raw.canStop === 'boolean') capabilities.canStop = raw.canStop;
    if (typeof raw.canClear === 'boolean') capabilities.canClear = raw.canClear;
    return Object.keys(capabilities).length > 0 ? capabilities : null;
}

function readItem(value: unknown): ReadItemResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { type: 'invalid' };
    const raw = value as Record<string, unknown>;
    const kind = readString(raw.kind);
    const origin = readString(raw.origin);
    const status = readString(raw.status);
    if (!kind || !origin || !status) return { type: 'invalid' };
    if (!VALID_KINDS.has(kind) || !VALID_ORIGINS.has(origin) || !VALID_STATUSES.has(status)) {
        return { type: 'ignored' };
    }
    const id = readString(raw.id);
    const title = readString(raw.title);
    const updatedAt = readNonNegativeNumber(raw.updatedAt);
    if (!id || !title || updatedAt === null) return { type: 'invalid' };
    const statusReason = readStatusReason(raw.statusReason);
    const goalCapabilities = readGoalCapabilities(raw.goalCapabilities);

    return {
        type: 'item',
        item: {
            id,
            kind: kind as SessionWorkStateKind,
            origin: origin as SessionWorkStateOrigin,
            status: status as SessionWorkStateStatus,
            title,
            updatedAt,
            ...(statusReason ? { statusReason } : {}),
            ...(goalCapabilities ? { goalCapabilities } : {}),
            ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
            ...(typeof raw.backendId === 'string' ? { backendId: raw.backendId } : {}),
            ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
            ...(typeof raw.vendorRef === 'string' ? { vendorRef: raw.vendorRef } : {}),
            ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}),
            ...(readString(raw.parentId) ? { parentId: readString(raw.parentId) as string } : {}),
            ...(typeof raw.priority === 'string' ? { priority: raw.priority } : {}),
            ...(typeof raw.progress === 'number' && Number.isFinite(raw.progress) && raw.progress >= 0 && raw.progress <= 1 ? { progress: raw.progress } : {}),
            ...(typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget) ? { tokenBudget: raw.tokenBudget } : {}),
            ...(raw.tokenBudget === null ? { tokenBudget: null } : {}),
            ...(typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) ? { tokensUsed: raw.tokensUsed } : {}),
            ...(typeof raw.timeUsedSeconds === 'number' && Number.isFinite(raw.timeUsedSeconds) ? { timeUsedSeconds: raw.timeUsedSeconds } : {}),
            ...(readNonNegativeNumber(raw.createdAt) !== null ? { createdAt: readNonNegativeNumber(raw.createdAt) as number } : {}),
            ...(readNonNegativeNumber(raw.startedAt) !== null ? { startedAt: readNonNegativeNumber(raw.startedAt) as number } : {}),
            ...(readNonNegativeNumber(raw.completedAt) !== null ? { completedAt: readNonNegativeNumber(raw.completedAt) as number } : {}),
        },
    };
}

function readTruncation(value: unknown): SessionWorkStateSnapshot['truncated'] | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (raw.reason !== 'item_limit' && raw.reason !== 'provider_limit') return null;
    const omittedCount = readNonNegativeNumber(raw.omittedCount);
    return {
        reason: raw.reason,
        ...(omittedCount !== null && Number.isInteger(omittedCount) ? { omittedCount } : {}),
    };
}

function readCanonicalSnapshot(value: unknown): SessionWorkStateSnapshot | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    if (raw.v !== 1) return null;
    const backendId = readString(raw.backendId);
    const updatedAt = readNonNegativeNumber(raw.updatedAt);
    if (!backendId || updatedAt === null || !Array.isArray(raw.items)) return null;
    const parsedItems = raw.items.map(readItem);
    const items = parsedItems
        .filter((item): item is Readonly<{ type: 'item'; item: SessionWorkStateItem }> => item.type === 'item')
        .map((item) => item.item);
    if (items.length === 0) return null;

    const truncated = readTruncation(raw.truncated);
    return {
        v: 1,
        backendId,
        updatedAt,
        items,
        ...(typeof raw.agentId === 'string' ? { agentId: raw.agentId } : {}),
        ...(typeof raw.primaryItemId === 'string' || raw.primaryItemId === null ? { primaryItemId: raw.primaryItemId } : {}),
        ...(truncated ? { truncated } : {}),
    };
}

function readLegacyGoalSnapshot(metadata: Record<string, unknown>): SessionWorkStateSnapshot | null {
    const rawGoal = metadata.sessionGoalV1 ?? metadata.codexGoalV1;
    if (!rawGoal || typeof rawGoal !== 'object' || Array.isArray(rawGoal)) return null;
    const raw = rawGoal as Record<string, unknown>;
    const title = readString(raw.objective) ?? readString(raw.title);
    if (!title) return null;
    const rawStatus = readString(raw.status);
    const status: SessionWorkStateStatus = rawStatus && VALID_STATUSES.has(rawStatus) ? rawStatus as SessionWorkStateStatus : 'active';
    const updatedAt = readNumber(raw.updatedAt) ?? Date.now();
    const backendId = readString(metadata.flavor) ?? 'codex';
    const statusReason = readStatusReason(raw.statusReason);
    return {
        v: 1,
        backendId,
        updatedAt,
        primaryItemId: 'goal:legacy',
        items: [{
            id: 'goal:legacy',
            kind: 'goal',
            origin: 'vendor',
            status,
            title,
            updatedAt,
            ...(statusReason ? { statusReason } : {}),
            ...(typeof raw.tokenBudget === 'number' && Number.isFinite(raw.tokenBudget) ? { tokenBudget: raw.tokenBudget } : {}),
            ...(typeof raw.tokensUsed === 'number' && Number.isFinite(raw.tokensUsed) ? { tokensUsed: raw.tokensUsed } : {}),
            ...(typeof raw.timeUsedSeconds === 'number' && Number.isFinite(raw.timeUsedSeconds) ? { timeUsedSeconds: raw.timeUsedSeconds } : {}),
            ...(readNonNegativeNumber(raw.createdAt) !== null ? { createdAt: readNonNegativeNumber(raw.createdAt) as number } : {}),
            ...(readNonNegativeNumber(raw.startedAt) !== null ? { startedAt: readNonNegativeNumber(raw.startedAt) as number } : {}),
            ...(readNonNegativeNumber(raw.completedAt) !== null ? { completedAt: readNonNegativeNumber(raw.completedAt) as number } : {}),
        }],
    };
}

export function readSessionWorkStateFromMetadata(metadata: unknown): SessionWorkStateSnapshot | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const raw = metadata as Record<string, unknown>;
    return readCanonicalSnapshot(raw.sessionWorkStateV1) ?? readLegacyGoalSnapshot(raw);
}

function firstItem(snapshot: SessionWorkStateSnapshot | null, predicate: (item: SessionWorkStateItem) => boolean): SessionWorkStateItem | null {
    return snapshot?.items.find(predicate) ?? null;
}

/**
 * The session's CURRENT goal for "current goal" surfaces (the AgentInput goal chip label): only a
 * `kind:'goal'` item with `status:'active'`. Completed, cancelled/cleared, paused, or blocked goals
 * are deliberately NOT current, so those surfaces fall back to the "Set goal" affordance. Mirrors
 * happy's `resolveVisibleAgentGoalStatus` (active-only). This is intentionally distinct from
 * `resolvePrimarySessionWorkStateItem`, which also returns inactive items for the status badge.
 */
export function resolveActiveSessionGoalItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    return firstItem(snapshot, (item) => item.kind === 'goal' && item.status === 'active');
}

function isTerminalWorkStateStatus(status: SessionWorkStateStatus): boolean {
    return status === 'complete' || status === 'cancelled';
}

export function resolvePrimarySessionWorkStateItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    if (!snapshot || snapshot.items.length === 0) return null;
    const primaryId = typeof snapshot.primaryItemId === 'string' ? snapshot.primaryItemId : null;
    if (primaryId) {
        const primary = snapshot.items.find((item) => item.id === primaryId);
        // Trust the published primary unless it is terminal (complete/cancelled) while a non-terminal
        // item still exists: a stale/legacy primaryItemId must not pin a finished row over active
        // work. This mirrors the protocol write-side resolver's status-rank rule (G4) so the read and
        // write paths agree, while still surfacing a completed/cancelled item when ALL items are
        // terminal (a history badge).
        if (primary && (!isTerminalWorkStateStatus(primary.status)
            || !snapshot.items.some((item) => !isTerminalWorkStateStatus(item.status)))) {
            return primary;
        }
    }
    return firstItem(snapshot, (item) => item.kind === 'task' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'todo' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'goal' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.status === 'blocked')
        ?? firstItem(snapshot, (item) => item.status === 'paused')
        ?? firstItem(snapshot, (item) => item.status === 'pending')
        ?? snapshot.items[0] ?? null;
}

export function formatSessionWorkStateBadgeLabel(item: SessionWorkStateItem | null, translate: Translate): string | null {
    if (!item) return null;
    if (item.kind === 'goal') {
        // A cancelled (cleared) goal is not a current goal — it must NOT render as a badge (mirrors
        // happy's resolveVisibleAgentGoalStatus, which only surfaces active goals). Returning null
        // means the cleared goal produces no badge, so clearing a goal removes the badge.
        if (item.status === 'cancelled') return null;
        if (item.status === 'paused') return translate('session.workState.badge.goalPaused');
        if (item.statusReason === 'budgetLimited') return translate('session.workState.badge.goalBudgetLimited');
        if (item.status === 'blocked') return translate('session.workState.badge.goalBlocked');
        if (item.status === 'complete') return translate('session.workState.badge.goalComplete');
        return translate('session.workState.badge.goal', { title: item.title });
    }
    return translate('session.workState.badge.item', { title: item.title });
}

export function resolveSessionWorkStateBadgeTone(item: SessionWorkStateItem | null): 'neutral' | 'active' | 'paused' | 'warning' | 'complete' {
    if (!item) return 'neutral';
    if (item.status === 'active') return 'active';
    if (item.status === 'paused') return 'paused';
    if (item.status === 'blocked') return 'warning';
    if (item.status === 'complete' || item.status === 'cancelled') return 'complete';
    return 'neutral';
}

/**
 * Whether this item earns FILLED chrome in the composer status row.
 *
 * Fill means exactly one thing here: **a person is needed**. `blocked` and `paused` both wait on a
 * human — one to unblock, one to resume — so they fill. Everything else, live work included, stays
 * plain, and liveness is carried by the label rather than by chrome.
 *
 * A completed goal deliberately does NOT fill. It used to, which made the composer announce a
 * success several times a day in the same chrome an agent uses to ask for help; a fill that
 * sometimes means "well done" and sometimes means "you are needed" means neither. The success is
 * still visible — it keeps its `complete` tone and its label — it just stops demanding attention.
 */
export function resolveSessionWorkStateBadgeEmphasis(item: SessionWorkStateItem | null): 'quiet' | 'prominent' {
    if (!item) return 'quiet';
    if (item.status === 'blocked' || item.status === 'paused') return 'prominent';
    return 'quiet';
}

export function resolveSessionWorkStateStatusBadgePresentation(args: Readonly<{
    primaryItem: SessionWorkStateItem | null;
    activeStatusBadgeKey: string | null;
    editableGoal: boolean;
    translate: Translate;
}>): SessionWorkStateStatusBadgePresentation | null {
    if (args.primaryItem) {
        const label = formatSessionWorkStateBadgeLabel(args.primaryItem, args.translate);
        if (!label) return null;
        return {
            itemKind: args.primaryItem.kind,
            label,
            tone: resolveSessionWorkStateBadgeTone(args.primaryItem),
            emphasis: resolveSessionWorkStateBadgeEmphasis(args.primaryItem),
        };
    }

    if (args.editableGoal && args.activeStatusBadgeKey === SESSION_WORK_STATE_STATUS_BADGE_KEY) {
        return {
            itemKind: 'goal',
            label: args.translate('session.workState.goal.title'),
            tone: 'neutral',
            emphasis: 'quiet',
        };
    }

    return null;
}

export function groupSessionWorkStateItems(snapshot: SessionWorkStateSnapshot | null): Readonly<{
    active: readonly SessionWorkStateItem[];
    pending: readonly SessionWorkStateItem[];
    blockedPaused: readonly SessionWorkStateItem[];
    done: readonly SessionWorkStateItem[];
}> {
    const items = snapshot?.items ?? [];
    return {
        active: items.filter((item) => item.status === 'active'),
        pending: items.filter((item) => item.status === 'pending'),
        blockedPaused: items.filter((item) => item.status === 'blocked' || item.status === 'paused'),
        done: items.filter((item) => item.status === 'complete' || item.status === 'cancelled'),
    };
}
