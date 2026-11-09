import { describe, expect, it } from 'vitest';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildSessionListFilterQueryHomes, normalizeSessionListViewFilters } from '@/components/sessions/shell/search/sessionListViewFilters';
import { compileSessionListSpaceFilter } from '@/sync/domains/session/listing/sessionListWorkFilter';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionOrganizationServerKey } from './keys';
import { projectSessionSpaceMemberships, selectSessionSpaceMembershipTags } from './spaceMembership';
import type { UiSessionOrganizationTag } from './types';

describe('Space membership from tag relations', () => {
    it('queries and displays either overlapping tag without materializing Account settings', () => {
        const catalog = { serverId: 'catalog', accountId: 'catalog-owner' };
        const viewers = new Map([['destination', 'viewer']]);
        const space = { ...createDefaultCollectionSpaceV1('sessionWork'), id: 'manual',
            membership: { mode: 'manual_only' as const, tags: [] } };
        const tag = (tagId: string, spaceSettingsTarget = catalog): UiSessionOrganizationTag => ({
            tagId, tagKey: tagId, sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
            display: null, displayState: { status: 'available', value: { kind: 'space_membership', spaceId: space.id, spaceSettingsTarget } },
        });
        const byKey = Object.fromEntries(['first', 'second', 'foreign'].map(id => [
            buildSessionOrganizationServerKey('destination', id), tag(id, id === 'foreign' ? { ...catalog, accountId: 'other' } : catalog),
        ]));
        const selected = selectSessionSpaceMembershipTags(byKey, catalog);
        const [projected] = projectSessionSpaceMemberships([space], selected, viewers);
        expect(space.membership.tags).toEqual([]);
        expect(projected?.membership?.tags.map(item => item.tagId)).toEqual(['first', 'second']);
        if (!projected?.membership) throw new Error('Missing related membership');
        const membership = { filter: projected.filter, membership: projected.membership };
        const filter = normalizeSessionListFilterV1({ homeServerIds: ['destination'], scope: 'all_accessible' });
        const homes = buildSessionListFilterQueryHomes(normalizeSessionListViewFilters({ ...filter, searchQuery: '' }), {
            storage: 'active', includeInactive: true, mountedHomeServerIds: ['destination'],
            spaceMembership: membership, viewerAccountIdByServerId: viewers,
        });
        expect(homes[0]?.query.membership?.tagIds).toEqual(['first', 'second']);
        const matches = compileSessionListSpaceFilter(filter, 'destination', membership);
        const row = createSessionListRenderableSessionFixture({ ownerAccountId: 'viewer' });
        for (const tagId of ['first', 'second']) {
            expect(matches(row, { nowMs: 1, viewerAccountId: 'viewer', tagIds: [tagId] })).toBe('match');
        }
        expect(matches(row, { nowMs: 1, viewerAccountId: 'viewer', tagIds: ['foreign'] })).toBe('miss');
    });
});
