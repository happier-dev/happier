import { describe, expect, it } from 'vitest';

import type { ActivitySurfaceSnapshot } from '@/activity/presentation/activitySurfaceSnapshot';

import { buildDesktopActivityOverlayModel } from './buildDesktopActivityOverlayModel';

function createSnapshot(overrides: Partial<ActivitySurfaceSnapshot> = {}): ActivitySurfaceSnapshot {
    const base: ActivitySurfaceSnapshot = {
        version: 1,
        generatedAt: 1_700_000_000_000,
        counts: {
            unread: 1,
            permissionRequired: 1,
            actionRequired: 0,
            queuedInput: 0,
            thinking: 1,
            totalAttention: 2,
        },
        summaryCounts: {
            attentionCount: 2,
            runningCount: 1,
            permissionCount: 1,
        },
        primary: {
            sessionId: 'session-primary',
            title: 'Primary session',
            subtitle: 'agent on machine',
            previewText: 'Primary preview',
            statusText: 'Permission required',
            attentionState: 'permission_required',
            route: '/session/session-primary',
            target: 'open-session:session-primary',
            defaultTarget: 'open-session:session-primary',
            isPrimary: true,
            updatedAt: 1_700_000_000_000,
        },
        sessions: [
            {
                sessionId: 'session-primary',
                title: 'Primary session',
                subtitle: 'agent on machine',
                previewText: 'Primary preview',
                statusText: 'Permission required',
                attentionState: 'permission_required',
                route: '/session/session-primary',
                target: 'open-session:session-primary',
                defaultTarget: 'open-session:session-primary',
                isPrimary: true,
                updatedAt: 1_700_000_000_000,
            },
            {
                sessionId: 'session-secondary',
                title: 'Secondary session',
                subtitle: 'agent on machine',
                previewText: 'Secondary preview',
                statusText: 'Running',
                attentionState: 'thinking',
                route: '/session/session-secondary',
                target: 'open-session:session-secondary',
                defaultTarget: 'open-session:session-secondary',
                isPrimary: false,
                updatedAt: 1_700_000_000_000,
            },
        ],
        defaultTarget: 'open-primary-session',
        labels: {
            focusTitle: 'Focus',
            sessionsTitle: 'Sessions',
            emptyTitle: 'No active sessions',
            openLabel: 'Open',
            inboxLabel: 'Inbox',
            attentionLabel: 'Attention',
            runningLabel: 'Running',
            permissionLabel: 'Permission',
        },
    };

    return {
        ...base,
        ...overrides,
    };
}

describe('buildDesktopActivityOverlayModel', () => {
    it('marks overlay visible when enabled and attention is present in attention mode', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: {
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
        expect(model.collapsed.title).toBe('Primary session');
        expect(model.collapsed.defaultTarget).toBe('open-primary-session');
        expect(model.collapsed.sessionCount).toBe(2);
        expect(model.expanded.rows).toHaveLength(2);
        expect(model.window.collapsed.width).toBeGreaterThan(200);
        expect(model.window.expanded.height).toBeGreaterThan(model.window.collapsed.height);
    });

    it('stays hidden when disabled regardless of counts', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: {
                enabled: false,
                visibilityMode: 'always_when_enabled',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
    });

    it('uses empty fallback copy when there is no primary session', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    queuedInput: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                primary: null,
                sessions: [],
            }),
            policy: {
                enabled: true,
                visibilityMode: 'always_when_enabled',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
        expect(model.collapsed.title).toBe('No active sessions');
        expect(model.expanded.rows).toHaveLength(0);
    });

    it('uses the canonical primary preview text when collapsed preview text is enabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: {
                enabled: true,
                visibilityMode: 'always_when_enabled',
                showWhenRunning: true,
                showWhenAttentionRequired: true,
                showWhenReady: true,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: true,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.collapsed.previewText).toBe('Primary preview');
    });

    it('stays hidden in attention-only mode when sessions exist but every auto-show trigger is disabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    queuedInput: 1,
                    thinking: 1,
                    totalAttention: 0,
                },
            }),
            policy: {
                enabled: true,
                visibilityMode: 'attention_only',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.visible).toBe(false);
    });

    it('stays visible in active-sessions mode when sessions exist even if every auto-show trigger is disabled', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    queuedInput: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
            }),
            policy: {
                enabled: true,
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
                alwaysOnTop: true,
                autoHideEnabled: true,
                autoHideDelayMs: 6000,
                clickAction: 'expand_overlay',
                density: 'compact',
                compactStyle: 'pill',
                showSessionCount: true,
                showPreviewText: false,
                placementMode: 'anchored',
                anchor: 'top_center',
                offsetX: 0,
                offsetY: 0,
                enableDragReposition: false,
                lockPosition: true,
            },
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
    });
});
