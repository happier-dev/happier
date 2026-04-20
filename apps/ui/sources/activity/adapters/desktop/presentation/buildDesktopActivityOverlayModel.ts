import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

import { buildDesktopActivityOverlayCollapsedModel } from './model/buildDesktopActivityOverlayCollapsedModel';
import { buildDesktopActivityOverlayExpandedCards } from './model/buildDesktopActivityOverlayExpandedCards';
import type {
    DesktopActivityOverlayModel,
    DesktopActivityOverlayWindowSizeParams,
} from './model/desktopActivityOverlayModelTypes';
import type { DesktopActivityOverlaySnapshot } from './snapshot/desktopActivityOverlaySnapshotTypes';

export type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayModel,
} from './model/desktopActivityOverlayModelTypes';

const desktopActivityOverlayCollapsedWindowSizeByDensity = {
    comfortable: {
        pill: { width: 236, height: 40 },
        panel: { width: 372, height: 76 },
    },
    compact: {
        pill: { width: 224, height: 38 },
        panel: { width: 336, height: 68 },
    },
} as const satisfies Record<
    'comfortable' | 'compact',
    Record<'pill' | 'panel', Readonly<{ width: number; height: number }>>
>;

function resolveVisibility(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    policy: DesktopOverlayPolicy;
}>): boolean {
    if (!params.policy.enabled) {
        return false;
    }

    if (params.policy.visibilityMode === 'always_when_enabled') {
        return true;
    }

    const hasAttention = params.policy.showWhenAttentionRequired && params.snapshot.counts.totalAttention > 0;
    const hasRunning = params.policy.showWhenRunning && params.snapshot.counts.thinking > 0;
    const hasReady = params.policy.showWhenReady && params.snapshot.counts.queuedInput > 0;
    const hasAnyTrigger = hasAttention || hasRunning || hasReady;
    if (params.policy.visibilityMode === 'attention_only') {
        return hasAnyTrigger;
    }

    const hasActiveSessions = params.snapshot.sessions.length > 0;
    return hasAnyTrigger || hasActiveSessions;
}

function resolveWindowSize(params: DesktopActivityOverlayWindowSizeParams): Readonly<{
    collapsed: Readonly<{ width: number; height: number }>;
    expanded: Readonly<{ width: number; height: number }>;
}> {
    const collapsed = desktopActivityOverlayCollapsedWindowSizeByDensity[params.density][params.compactStyle];
    const expandedWidth = params.density === 'comfortable' ? 444 : 408;
    const rowHeight = params.density === 'comfortable' ? 60 : 54;
    const expandedBaseHeight = params.density === 'comfortable' ? 64 : 46;
    const expandedMinHeight = params.density === 'comfortable' ? 152 : 118;
    const expandedHeight = Math.min(
        params.density === 'comfortable' ? 500 : 432,
        Math.max(expandedMinHeight, expandedBaseHeight + rowHeight * params.rowCount),
    );
    return {
        collapsed,
        expanded: {
            width: expandedWidth,
            height: expandedHeight,
        },
    };
}

function resolveExpandedWindowRowCount(
    cards: readonly NonNullable<DesktopActivityOverlayModel['expanded']['cards']>[number][],
    fallbackRowCount: number,
): number {
    if (cards.length === 0) {
        return fallbackRowCount;
    }

    return cards.reduce((total, card) => {
        switch (card.kind) {
            case 'multi_session_list':
                return total + card.rows.length;
            case 'permission_request':
            case 'user_question':
                return total + 2;
            case 'idle_state':
            case 'quota_summary':
            case 'completion_state':
            case 'session_overview':
            default:
                return total + 1;
        }
    }, 0);
}

export function buildDesktopActivityOverlayModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    policy: DesktopOverlayPolicy;
    isExpanded: boolean;
}>): DesktopActivityOverlayModel {
    const rows = params.snapshot.sessions.slice(0, 8).map((session) => ({
        sessionId: session.sessionId,
        title: session.title,
        subtitle: session.subtitle ?? null,
        statusText: session.statusText ?? null,
        previewText: session.previewText ?? null,
    }));
    const cards = buildDesktopActivityOverlayExpandedCards(params.snapshot);
    const window = resolveWindowSize({
        density: params.policy.density,
        compactStyle: params.policy.compactStyle,
        rowCount: resolveExpandedWindowRowCount(cards, rows.length),
    });

    return {
        visible: resolveVisibility({ snapshot: params.snapshot, policy: params.policy }),
        isExpanded: params.isExpanded,
        generatedAt: params.snapshot.generatedAt,
        collapsed: buildDesktopActivityOverlayCollapsedModel({
            snapshot: params.snapshot,
            cards,
            showSessionCount: params.policy.showSessionCount,
        }),
        expanded: {
            title: params.snapshot.labels.sessionsTitle,
            rows,
            cards,
        },
        window,
    };
}
