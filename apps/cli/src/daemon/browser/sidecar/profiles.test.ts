import { describe, expect, it } from 'vitest';

describe('daemon browser sidecar profile planning', () => {
    it('binds session-owned sidecar profiles as ephemeral by default and plans cleanup', async () => {
        const mod = await import('./profiles');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarProfileBinding({
            profile: {
                profileId: 'profile_1',
                storageMode: 'ephemeral',
                owner: { kind: 'session', id: 'session_1' },
                cleanupOnSessionClose: true,
            },
            allowPersistentProfiles: false,
            profileDirectory: '/tmp/happier/sidecar/profile_1',
        });

        expect(result).toMatchObject({
            ok: true,
            binding: {
                profileId: 'profile_1',
                storageMode: 'ephemeral',
                ownerKind: 'session',
                ownerId: 'session_1',
            },
            cleanup: {
                cleanupOnStop: true,
                profileDirectory: '/tmp/happier/sidecar/profile_1',
            },
        });
    });

    it('denies persistent sidecar profiles until profile policy explicitly allows them', async () => {
        const mod = await import('./profiles');

        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = mod.resolveSidecarProfileBinding({
            profile: {
                profileId: 'profile_user_1',
                storageMode: 'user',
                owner: { kind: 'user', id: 'account_1' },
                cleanupOnSessionClose: false,
            },
            allowPersistentProfiles: false,
            profileDirectory: '/Users/test/.happier/browser/profiles/profile_user_1',
        });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'profile_policy_denied',
        });
        expect(JSON.stringify(result)).not.toContain('/Users/test/.happier/browser/profiles/profile_user_1');
    });
});
