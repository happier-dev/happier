import { describe, expect, it } from 'vitest';

import type { DesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

import { buildDesktopActivityOverlayModel } from './buildDesktopActivityOverlayModel';

function createSnapshot(overrides: Partial<DesktopActivityOverlaySnapshot> = {}): DesktopActivityOverlaySnapshot {
    const base: DesktopActivityOverlaySnapshot = {
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
            statusText: 'Permission required',
            previewText: null,
        },
        sessions: [
            {
                sessionId: 'session-primary',
                title: 'Primary session',
                subtitle: 'agent on machine',
                statusText: 'Permission required',
                previewText: null,
            },
            {
                sessionId: 'session-secondary',
                title: 'Secondary session',
                subtitle: 'agent on machine',
                statusText: 'Running',
                previewText: null,
            },
        ],
        defaultTarget: 'open-primary-session',
        labels: {
            sessionsTitle: 'Sessions',
            emptyTitle: 'No active sessions',
        },
    };

    return {
        ...base,
        ...overrides,
    };
}

function createPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    const base: DesktopOverlayPolicy = {
        enabled: true,
        visibilityMode: 'attention_only',
        showWhenRunning: true,
        showWhenAttentionRequired: true,
        showWhenReady: true,
        alwaysOnTop: true,
        autoHideEnabled: true,
        autoHideDelayMs: 6000,
        expandedBehavior: 'click',
        interactiveCollapsed: true,
        presentationMode: 'automatic',
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
            policy: createPolicy(),
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

    it('keeps pill collapsed windows tighter than panel collapsed windows for the same density', () => {
        const pillModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'pill',
                density: 'compact',
            }),
            isExpanded: false,
        });
        const panelModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'panel',
                density: 'compact',
            }),
            isExpanded: false,
        });

        expect(pillModel.window.collapsed.width).toBeLessThan(panelModel.window.collapsed.width);
        expect(pillModel.window.collapsed.height).toBeLessThan(panelModel.window.collapsed.height);
    });

    it('keeps compact collapsed windows in the tighter premium range', () => {
        const pillModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'pill',
                density: 'compact',
            }),
            isExpanded: false,
        });
        const panelModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                compactStyle: 'panel',
                density: 'compact',
            }),
            isExpanded: false,
        });

        expect(pillModel.window.collapsed.width).toBeLessThanOrEqual(312);
        expect(pillModel.window.collapsed.height).toBeLessThanOrEqual(60);
        expect(panelModel.window.collapsed.height).toBeLessThanOrEqual(68);
    });

    it('stays hidden when disabled regardless of counts', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                enabled: false,
                visibilityMode: 'always_when_enabled',
            }),
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
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
        expect(model.collapsed.title).toBe('No active sessions');
        expect(model.expanded.rows).toHaveLength(0);
    });

    it('omits widget-only fields from the desktop overlay presentation contract', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
            isExpanded: true,
        });

        expect(model.collapsed).not.toHaveProperty('subtitle');
        expect(model.collapsed).not.toHaveProperty('previewText');
        expect(model.collapsed).not.toHaveProperty('attentionCount');
        expect(model.expanded.rows[0]).not.toHaveProperty('route');
        expect(model.expanded.rows[0]).not.toHaveProperty('target');
        expect(model.expanded.rows[0]).not.toHaveProperty('attentionState');
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
            policy: createPolicy({
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
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
            policy: createPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            isExpanded: false,
        });

        expect(model.visible).toBe(true);
    });
});
