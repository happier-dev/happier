import { describe, expect, it } from 'vitest';

import { getAvatarUrl, getLinkedProvider, profileDefaults, tryParseProfile, upsertProfileConnectedAccountGroup } from './profile';
import { ConnectedServiceAuthGroupPolicyV2Schema } from '@happier-dev/protocol/connect/connected-service-schemas';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

describe('profile helpers', () => {
    it('merges a selected pool read into the current profile without replacing other qualified groups or fields', () => {
        const group = { v: 1 as const, ref: { service: { pluginId: 'acme.one', localId: 'service' }, groupId: 'work' },
            displayName: 'Work', incarnation: 'work-row', generation: 1, runtimeStateRevision: 1,
            policy: ConnectedServiceAuthGroupPolicyV2Schema.parse({}), activeConnectedAccountId: null,
            state: {}, members: [], createdAt: 1, updatedAt: 1 };
        const foreign = { ...group, ref: { ...group.ref, service: { ...group.ref.service, pluginId: 'acme.other' } } };
        const profile = { ...profileDefaults, id: 'owner', name: 'Current name', connectedAccountGroupsV4: [foreign, group] };
        const selected = { ...group, displayName: 'Renamed', generation: 2 };
        const updated = upsertProfileConnectedAccountGroup(profile, selected);
        expect(updated).toEqual({ ...profile, connectedAccountGroupsV4: [foreign, selected] });
        expect(updated.connectedAccountGroupsV4[0]).toBe(foreign);
        expect(upsertProfileConnectedAccountGroup({ ...profile, connectedAccountGroupsV4: [foreign] }, selected)
            .connectedAccountGroupsV4).toEqual([foreign, selected]);
    });
    it('restores stored profiles while dropping retired nested fields', () => {
        const profile = { ...profileDefaults, id: 'account-a', connectedServicesV2: [{ serviceId: 'anthropic',
            profiles: [{ profileId: 'work', status: 'connected', retired: true }], retired: true }], retired: true };
        const parsed = tryParseProfile(profile);
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('retired');
        expect(parsed?.connectedServicesV2[0]?.profiles[0]).not.toHaveProperty('retired');
    });
    it('treats missing linkedProviders as an empty list when deriving display details', () => {
        const profile = {
            ...profileDefaults,
            name: 'Lee',
            firstName: 'Lee',
            linkedProviders: undefined,
            avatar: null,
        } as any;

        expect(formatAccountDisplayName(profile)).toBe('Lee');
        expect(getAvatarUrl(profile)).toBeNull();
        expect(getLinkedProvider(profile, 'anthropic')).toBeNull();
    });

    it('uses the canonical name or username without replacing a cleared name with a linked identity', () => {
        const profile = { ...profileDefaults, name: 'Chosen Name', firstName: 'Legacy', username: 'lee',
            linkedProviders: [{ id: 'github', displayName: 'Provider Name', login: 'provider-login', avatarUrl: null,
                profileUrl: null, showOnProfile: true }] };
        expect(formatAccountDisplayName(profile)).toBe('Chosen Name');
        expect(formatAccountDisplayName({ ...profile, name: null })).toBe('lee');
        expect(formatAccountDisplayName({ ...profile, name: null, username: null })).toBeNull();
    });
});
