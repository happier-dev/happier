import type { BrowserPermissionGrantV1 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

async function loadPermissionDecisionModule() {
    return import('./decisions').catch(() => null);
}

const grants = [{
    id: 'grant_profile',
    profileId: 'profile_1',
    origin: 'https://preview.example.test',
    permission: 'downloads',
    state: 'allowed',
    scope: 'profile',
    updatedAt: 1_000,
}, {
    id: 'grant_target',
    profileId: 'profile_1',
    origin: 'https://preview.example.test',
    permission: 'downloads',
    state: 'denied',
    scope: 'target',
    targetId: 'preview_1',
    updatedAt: 1_100,
}] satisfies readonly BrowserPermissionGrantV1[];

describe('resolveBrowserPermissionDecision', () => {
    it('prefers target-scoped grants over broader profile grants', async () => {
        const mod = await loadPermissionDecisionModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.resolveBrowserPermissionDecision({
            grants,
            profileId: 'profile_1',
            origin: 'https://preview.example.test',
            permission: 'downloads',
            targetId: 'preview_1',
            now: 1_200,
        })).toMatchObject({
            state: 'denied',
            source: 'grant',
            grantId: 'grant_target',
        });
    });

    it('fails closed to prompt when no unexpired grant matches', async () => {
        const mod = await loadPermissionDecisionModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.resolveBrowserPermissionDecision({
            grants: [],
            profileId: 'profile_1',
            origin: 'https://preview.example.test',
            permission: 'camera',
            targetId: 'preview_1',
            now: 1_200,
        })).toMatchObject({
            state: 'prompt',
            source: 'default',
        });
    });

    it('ignores profile-scoped grants without an owning profile id', async () => {
        const mod = await loadPermissionDecisionModule();

        expect(mod).not.toBeNull();
        if (!mod) return;

        expect(mod.resolveBrowserPermissionDecision({
            grants: [{
                id: 'grant_global_by_accident',
                origin: 'https://preview.example.test',
                permission: 'downloads',
                state: 'allowed',
                scope: 'profile',
                updatedAt: 1_000,
            }],
            profileId: 'profile_2',
            origin: 'https://preview.example.test',
            permission: 'downloads',
            now: 1_200,
        })).toMatchObject({
            state: 'prompt',
            source: 'default',
        });
    });
});
