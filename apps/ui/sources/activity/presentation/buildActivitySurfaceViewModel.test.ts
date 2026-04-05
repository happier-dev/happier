import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';

import { buildActivitySurfaceViewModel } from './buildActivitySurfaceViewModel';

describe('buildActivitySurfaceViewModel', () => {
    it('uses the status text as the title in status-only privacy mode', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
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
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'status_only',
            }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.title).not.toBe('Permission work');
        expect(viewModel.subtitle).toBeNull();
        expect(viewModel.statusText).toBeNull();
    });

    it('exposes preview text and session default targets from the canonical shared view model', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'permission',
                updatedAt: 1_234,
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: '  Need\n\n your   approval  ', updatedAt: 3 },
                },
            }),
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            showMachinePath: true,
            showPreviewText: true,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.previewText).toBe('Need your approval');
        expect(viewModel.defaultTarget).toBe('open-session:permission');
        expect(viewModel.updatedAt).toBe(1_234);
    });

    it('hides preview text without stripping non-sensitive status text when previews are disabled', () => {
        const candidate = buildSessionActivityAttention({
            session: createSessionFixture({
                id: 'permission',
                active: true,
                presence: 'online',
                pendingPermissionRequestCount: 1,
                metadata: {
                    path: '/Users/tester/project/permission',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                    summary: { text: 'Need your approval', updatedAt: 3 },
                },
            }),
            nowMs: 1_000,
        });

        const viewModel = buildActivitySurfaceViewModel({
            candidate,
            policy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            showMachinePath: true,
            showPreviewText: false,
            isPrimary: true,
            nowMs: 1_000,
        });

        expect(viewModel.previewText).toBeNull();
        expect(viewModel.statusText).toBeTruthy();
    });
});
