import { describe, expect, it, vi } from 'vitest';

import { resolveProviderAccountUsageSourceProfile } from './resolveProviderAccountUsageSourceProfile';

describe('resolveProviderAccountUsageSourceProfile', () => {
    it('attributes a group usage observation to the unique member matching the provider account', async () => {
        const source = await resolveProviderAccountUsageSourceProfile({
            source: {
                serviceId: 'claude-subscription',
                profileId: 'stale-launch-profile',
                bindingKind: 'group_member',
                groupId: 'claude',
                groupGeneration: 4,
            },
            providerAccountId: 'account-live',
            getCurrentGroup: async () => ({
                generation: 9,
                members: [
                    { profileId: 'stale-launch-profile' },
                    { profileId: 'live-profile' },
                ],
            }),
            resolveProviderAccountId: async (profileId) =>
                profileId === 'live-profile' ? 'account-live' : 'account-old',
        });

        expect(source).toEqual({
            serviceId: 'claude-subscription',
            profileId: 'live-profile',
            bindingKind: 'group_member',
            groupId: 'claude',
            groupGeneration: 9,
        });
    });

    it('keeps the claimed source when provider identity is ambiguous', async () => {
        const claimedSource = {
            serviceId: 'claude-subscription' as const,
            profileId: 'launch-profile',
            bindingKind: 'group_member' as const,
            groupId: 'claude',
            groupGeneration: 4,
        };
        const source = await resolveProviderAccountUsageSourceProfile({
            source: claimedSource,
            providerAccountId: 'account-shared',
            getCurrentGroup: async () => ({
                generation: 9,
                members: [{ profileId: 'one' }, { profileId: 'two' }],
            }),
            resolveProviderAccountId: async () => 'account-shared',
        });

        expect(source).toBe(claimedSource);
    });

    it('does not read group truth for a direct-profile source', async () => {
        const getCurrentGroup = vi.fn();
        const claimedSource = {
            serviceId: 'claude-subscription' as const,
            profileId: 'direct-profile',
            bindingKind: 'profile' as const,
        };

        await expect(resolveProviderAccountUsageSourceProfile({
            source: claimedSource,
            providerAccountId: 'account-live',
            getCurrentGroup,
            resolveProviderAccountId: vi.fn(),
        })).resolves.toBe(claimedSource);
        expect(getCurrentGroup).not.toHaveBeenCalled();
    });
});
