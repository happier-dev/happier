import type {
    SessionWorkStateItem,
    SessionWorkStateKind,
    SessionWorkStateSnapshot,
} from '@/sync/domains/session/workState/sessionWorkStateTypes';

type WorkStateBadgeTranslationKey =
    | 'session.workState.badge.goal'
    | 'session.workState.badge.goalPaused'
    | 'session.workState.badge.goalBlocked'
    | 'session.workState.badge.goalBudgetLimited'
    | 'session.workState.badge.goalComplete'
    | 'session.workState.badge.item'
    | 'session.workState.goal.title';

type Translate = (key: WorkStateBadgeTranslationKey, params?: { title: string }) => string;

export const SESSION_WORK_STATE_STATUS_BADGE_KEY = 'work-state';

export type SessionWorkStateStatusBadgePresentation = Readonly<{
    itemKind: SessionWorkStateKind;
    label: string;
    tone: 'neutral' | 'active' | 'paused' | 'warning' | 'complete';
    emphasis: 'quiet' | 'prominent';
}>;

export function formatSessionWorkStateBadgeLabel(item: SessionWorkStateItem | null, translate: Translate): string | null {
    if (!item) return null;
    if (item.kind === 'goal') {
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

export function resolveSessionWorkStateBadgeEmphasis(item: SessionWorkStateItem | null): 'quiet' | 'prominent' {
    if (!item) return 'quiet';
    if (item.status === 'blocked' || item.status === 'paused') return 'prominent';
    if (item.kind === 'goal' && item.status === 'complete') return 'prominent';
    return 'quiet';
}

export function resolveSessionWorkStateStatusBadgePresentation(args: Readonly<{
    primaryItem: SessionWorkStateItem | null;
    activeStatusBadgeKey?: string | null;
    editableGoal?: boolean;
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

    if (args.editableGoal === true && args.activeStatusBadgeKey === SESSION_WORK_STATE_STATUS_BADGE_KEY) {
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
