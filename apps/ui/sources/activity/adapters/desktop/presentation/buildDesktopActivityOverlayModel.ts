import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import type { DesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';

export type DesktopActivityOverlayModel = Readonly<{
    visible: boolean;
    isExpanded: boolean;
    generatedAt: number;
    collapsed: Readonly<{
        title: string;
        statusText: string | null;
        defaultTarget: string;
        sessionCount: number | null;
    }>;
    expanded: Readonly<{
        title: string;
        rows: readonly Readonly<{
            sessionId: string;
            title: string;
            subtitle: string | null;
            statusText: string | null;
        }>[];
    }>;
    window: Readonly<{
        collapsed: Readonly<{ width: number; height: number }>;
        expanded: Readonly<{ width: number; height: number }>;
    }>;
}>;

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

function resolveWindowSize(params: Readonly<{
    density: DesktopOverlayPolicy['density'];
    rowCount: number;
}>): Readonly<{
    collapsed: Readonly<{ width: number; height: number }>;
    expanded: Readonly<{ width: number; height: number }>;
}> {
    const collapsed =
        params.density === 'comfortable'
            ? { width: 380, height: 84 }
            : { width: 340, height: 72 };
    const expandedWidth = params.density === 'comfortable' ? 460 : 420;
    const rowHeight = params.density === 'comfortable' ? 64 : 58;
    const expandedHeight = Math.min(
        params.density === 'comfortable' ? 520 : 460,
        Math.max(params.density === 'comfortable' ? 180 : 160, 96 + rowHeight * params.rowCount),
    );
    return {
        collapsed,
        expanded: {
            width: expandedWidth,
            height: expandedHeight,
        },
    };
}

export function buildDesktopActivityOverlayModel(params: Readonly<{
    snapshot: DesktopActivityOverlaySnapshot;
    policy: DesktopOverlayPolicy;
    isExpanded: boolean;
}>): DesktopActivityOverlayModel {
    const primary = params.snapshot.primary;
    const rows = params.snapshot.sessions.slice(0, 8).map((session) => ({
            sessionId: session.sessionId,
            title: session.title,
            subtitle: session.subtitle ?? null,
            statusText: session.statusText ?? null,
        }));
    const window = resolveWindowSize({
        density: params.policy.density,
        rowCount: rows.length,
    });

    return {
        visible: resolveVisibility({ snapshot: params.snapshot, policy: params.policy }),
        isExpanded: params.isExpanded,
        generatedAt: params.snapshot.generatedAt,
        collapsed: {
            title: primary?.title ?? params.snapshot.labels.emptyTitle,
            statusText: primary?.statusText ?? null,
            defaultTarget: params.snapshot.defaultTarget,
            sessionCount: params.policy.showSessionCount ? params.snapshot.sessions.length : null,
        },
        expanded: {
            title: params.snapshot.labels.sessionsTitle,
            rows,
        },
        window,
    };
}
