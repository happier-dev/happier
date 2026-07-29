import { describe, expect, it } from 'vitest';

import { LOCAL_BROWSER_PROFILE, LOCAL_BROWSER_PROFILE_ID } from '@/sync/domains/browser/profiles/localBrowserProfile';

import type { BrowserProfileStatusModel } from './BrowserProfileStatus';
import { shouldSurfaceBrowserPrivacy } from './browserPrivacyVisibility';

function defaultModel(overrides: Partial<BrowserProfileStatusModel> = {}): BrowserProfileStatusModel {
    return {
        profile: LOCAL_BROWSER_PROFILE,
        ...overrides,
    };
}

describe('shouldSurfaceBrowserPrivacy (B-RC5)', () => {
    it('is false for the host-local default profile with no partition/grants/management', () => {
        expect(shouldSurfaceBrowserPrivacy(defaultModel())).toBe(false);
    });

    it('is true for a non-default profile', () => {
        const model = defaultModel({
            profile: {
                profileId: 'profile_custom',
                storageMode: 'session',
                owner: { kind: 'session', id: 'session_1' },
                displayName: 'Custom',
                lifecycleState: 'active',
                cleanupOnSessionClose: true,
            },
        });
        expect(shouldSurfaceBrowserPrivacy(model)).toBe(true);
    });

    it('is true when a storage partition is present', () => {
        const model = defaultModel({
            storagePartition: {
                partitionId: 'partition_1',
                profileId: LOCAL_BROWSER_PROFILE_ID,
                originKey: 'https://preview.test',
                targetKind: 'localServicePreview',
                persistence: 'session',
                state: 'active',
                createdAt: 1,
                updatedAt: 1,
            },
        });
        expect(shouldSurfaceBrowserPrivacy(model)).toBe(true);
    });

    it('is true when there is at least one active permission grant', () => {
        expect(shouldSurfaceBrowserPrivacy(defaultModel({ activePermissionGrantCount: 1 }))).toBe(true);
    });

    it('is true when the permission state is actionable (denied/prompt)', () => {
        expect(shouldSurfaceBrowserPrivacy(defaultModel({ permissionState: 'denied' }))).toBe(true);
        expect(shouldSurfaceBrowserPrivacy(defaultModel({ permissionState: 'prompt' }))).toBe(true);
    });

    it('stays false for a non-actionable allowed permission state with zero grants', () => {
        expect(shouldSurfaceBrowserPrivacy(defaultModel({ permissionState: 'allowed' }))).toBe(false);
    });

    it('is true when management actions are available', () => {
        expect(shouldSurfaceBrowserPrivacy(defaultModel({ management: {} }))).toBe(true);
    });
});
