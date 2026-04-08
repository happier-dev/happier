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
            previewText: string | null;
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
    compactStyle: DesktopOverlayPolicy['compactStyle'];
    rowCount: number;
}>): Readonly<{
    collapsed: Readonly<{ width: number; height: number }>;
    expanded: Readonly<{ width: number; height: number }>;
}> {
    const collapsed =
        params.density === 'comfortable'
            ? (
                params.compactStyle === 'pill'
                    ? { width: 268, height: 48 }
                    : { width: 372, height: 76 }
            )
            : (
                params.compactStyle === 'pill'
                    ? { width: 240, height: 42 }
                    : { width: 336, height: 68 }
            );
    const expandedWidth = params.density === 'comfortable' ? 444 : 408;
    const rowHeight = params.density === 'comfortable' ? 60 : 54;
    const expandedHeight = Math.min(
        params.density === 'comfortable' ? 500 : 432,
        Math.max(params.density === 'comfortable' ? 168 : 148, 86 + rowHeight * params.rowCount),
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
        previewText: session.previewText ?? null,
    }));
    const window = resolveWindowSize({
        density: params.policy.density,
        compactStyle: params.policy.compactStyle,
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
