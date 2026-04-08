import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';

import { buildDesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';

function createDesktopPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    return {
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
        ...overrides,
    };
}

describe('buildDesktopActivityOverlaySnapshot', () => {
    it('keeps active-session overlays focused on active sessions even when auto-show triggers are disabled', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
                createSessionFixture({
                    id: 'quiet-active',
                    seq: 3,
                    lastViewedSessionSeq: 3,
                    active: true,
                    presence: 'online',
                    metadata: {
                        path: '/Users/tester/project/quiet-active',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet active work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    id: 'inactive-unread',
                    seq: 10,
                    lastViewedSessionSeq: 1,
                    active: false,
                    presence: 1,
                    metadata: {
                        path: '/Users/tester/project/inactive-unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Inactive unread work', updatedAt: 4 },
                    },
                }),
            ],
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            nowMs: 1_000,
        });

        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            isExpanded: false,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
            'permission',
            'thinking',
            'quiet-active',
        ]);
        expect(model.collapsed.sessionCount).toBe(3);
    });

    it('keeps desktop preview text in the snapshot when the overlay setting enables it', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            sessions: [
                createSessionFixture({
                    id: 'preview-session',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    metadata: {
                        path: '/Users/tester/project/preview',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
            ],
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({
                showPreviewText: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions[0]).toHaveProperty('previewText', 'Need your approval');
    });

    it('falls back to recent sessions in always-when-enabled mode when no desktop selection candidates qualify', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            sessions: [
                createSessionFixture({
                    id: 'quiet-inactive',
                    active: false,
                    presence: 'online',
                    thinking: false,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    pendingCount: 0,
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    metadata: {
                        path: '/Users/tester/project/quiet-inactive',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet recent work', updatedAt: 5 },
                    },
                }),
            ],
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'always_when_enabled',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
                showPreviewText: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(['quiet-inactive']);
        expect(snapshot.primary?.sessionId).toBe('quiet-inactive');
        expect(snapshot.defaultTarget).toBe('open-session:quiet-inactive');
    });
});
