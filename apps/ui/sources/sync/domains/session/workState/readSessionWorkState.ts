import {
    readSessionWorkStateV1FromMetadata,
    type SessionWorkStateItemV1,
    type SessionWorkStateV1,
} from '@happier-dev/protocol';

import type {
    SessionWorkStateItem,
    SessionWorkStateSnapshot,
    SessionWorkStateStatus,
    SessionWorkStateStatusReason,
} from './sessionWorkStateTypes';

const VALID_STATUSES: ReadonlySet<string> = new Set([
    'pending',
    'active',
    'paused',
    'blocked',
    'complete',
    'cancelled',
    'unknown',
]);

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
    return value === 'budgetLimited' ? value : null;
}

function toUiWorkStateItem(item: SessionWorkStateItemV1): SessionWorkStateItem {
    return {
        id: item.id,
        kind: item.kind,
        origin: item.origin,
        status: item.status,
        title: item.title,
        updatedAt: item.updatedAt,
        ...(item.statusReason ? { statusReason: item.statusReason } : {}),
        ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
        ...(typeof item.backendId === 'string' ? { backendId: item.backendId } : {}),
        ...(typeof item.agentId === 'string' ? { agentId: item.agentId } : {}),
        ...(typeof item.vendorRef === 'string' ? { vendorRef: item.vendorRef } : {}),
        ...(typeof item.order === 'number' ? { order: item.order } : {}),
        ...(typeof item.priority === 'string' ? { priority: item.priority } : {}),
        ...(typeof item.tokenBudget === 'number' || item.tokenBudget === null ? { tokenBudget: item.tokenBudget } : {}),
        ...(typeof item.tokensUsed === 'number' ? { tokensUsed: item.tokensUsed } : {}),
        ...(typeof item.timeUsedSeconds === 'number' ? { timeUsedSeconds: item.timeUsedSeconds } : {}),
        ...(typeof item.createdAt === 'number' ? { createdAt: item.createdAt } : {}),
        ...(typeof item.startedAt === 'number' ? { startedAt: item.startedAt } : {}),
        ...(typeof item.completedAt === 'number' ? { completedAt: item.completedAt } : {}),
    };
}

function toUiWorkStateSnapshot(snapshot: SessionWorkStateV1): SessionWorkStateSnapshot | null {
    if (snapshot.items.length === 0) return null;
    return {
        v: 1,
        backendId: snapshot.backendId,
        updatedAt: snapshot.updatedAt,
        items: snapshot.items.map(toUiWorkStateItem),
        ...(typeof snapshot.agentId === 'string' ? { agentId: snapshot.agentId } : {}),
        ...(typeof snapshot.primaryItemId === 'string' || snapshot.primaryItemId === null ? { primaryItemId: snapshot.primaryItemId } : {}),
        ...(snapshot.truncated ? { truncated: snapshot.truncated } : {}),
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
    const canonical = readSessionWorkStateV1FromMetadata(raw);
    return canonical ? toUiWorkStateSnapshot(canonical) : readLegacyGoalSnapshot(raw);
}

function firstItem(snapshot: SessionWorkStateSnapshot | null, predicate: (item: SessionWorkStateItem) => boolean): SessionWorkStateItem | null {
    return snapshot?.items.find(predicate) ?? null;
}

export function resolvePrimarySessionWorkStateItem(snapshot: SessionWorkStateSnapshot | null): SessionWorkStateItem | null {
    if (!snapshot || snapshot.items.length === 0) return null;
    const primaryId = typeof snapshot.primaryItemId === 'string' ? snapshot.primaryItemId : null;
    if (primaryId) {
        const primary = snapshot.items.find((item) => item.id === primaryId);
        if (primary) return primary;
    }
    return firstItem(snapshot, (item) => item.kind === 'task' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'todo' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.kind === 'goal' && item.status === 'active')
        ?? firstItem(snapshot, (item) => item.status === 'blocked')
        ?? firstItem(snapshot, (item) => item.status === 'pending')
        ?? null;
}
