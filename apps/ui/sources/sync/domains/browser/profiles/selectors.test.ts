import type { BrowserProfileV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadProfileSelectorsModule() {
    return import('./selectors').catch(() => null);
}

const profile = {
    profileId: 'profile_1',
    storageMode: 'session',
    owner: { kind: 'session', id: 'session_1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    cleanupOnSessionClose: true,
} satisfies BrowserProfileV1;

describe('browser profile selectors', () => {
    it('returns null for missing or unusable profiles', async () => {
        const mod = await loadProfileSelectorsModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.selectUsableBrowserProfile({
            profilesById: { profile_1: profile },
        }, 'missing_profile')).toBeNull();

        expect(mod.selectUsableBrowserProfile({
            profilesById: {
                profile_1: {
                    ...profile,
                    lifecycleState: 'unusable',
                    disabledReasons: ['purge_failed'],
                },
            },
        }, 'profile_1')).toBeNull();
    });
});
