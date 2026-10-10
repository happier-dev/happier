import { describe, expect, it } from 'vitest';

import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';

import {
    buildHomeCollection,
    describeHomeRow,
    homeCollectionHref,
    resolveSelectedHomeCollectionKey,
} from './homeCollectionModel';

function profile(id: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
    return { id, name: '', serverUrl: `https://${id}.example.test`, ...overrides } as unknown as ServerProfile;
}

describe('buildHomeCollection', () => {
    it('keeps unnamed Home addresses in metadata even when a status fact is present', () => {
        const collection = buildHomeCollection({
            servers: [profile('home-a'), profile('home-b')], groups: [], activeServerId: 'home-a',
            activeTargetKey: null, deviceDefaultServerId: null,
            authStatusByServerId: { 'home-a': 'signedIn', 'home-b': 'signedOut' },
            homeConnectionSummaryByServerId: {},
        });
        for (const row of collection.homes) {
            expect(row.title).not.toContain(row.serverUrl);
            expect(describeHomeRow(row)).toContain(`${row.id}.example.test`);
        }
    });

    it('lists the Home in use first, then the other Homes in their saved order, then groups', () => {
        const collection = buildHomeCollection({
            servers: [profile('acme', { name: 'Acme' }), profile('personal', { name: 'Studio' }), profile('cloud', { name: 'Cloud' })],
            groups: [{ id: 'g1', name: 'Work', serverIds: ['acme', 'cloud'] } as unknown as ServerSelectionGroup],
            activeServerId: 'personal',
            activeTargetKey: null,
            deviceDefaultServerId: null,
            authStatusByServerId: { acme: 'signedIn', personal: 'signedIn', cloud: 'signedOut' },
            homeConnectionSummaryByServerId: {},
        });
        expect(collection.homes.map((row) => [row.id, row.current])).toEqual([
            ['personal', true],
            ['acme', false],
            ['cloud', false],
        ]);
        // A signed-out Home says so: its line is the state, and it is the one that needs the person.
        expect(collection.homes.find((row) => row.id === 'cloud')).toMatchObject({ statusKey: 'action_required', needsAttention: true });
        expect(collection.homes.find((row) => row.id === 'acme')).toMatchObject({ needsAttention: false });
        expect(collection.groups.map((group) => [group.id, group.count])).toEqual([['g1', 2]]);
    });
});

describe('resolveSelectedHomeCollectionKey', () => {
    it('selects the row the route names', () => {
        expect(resolveSelectedHomeCollectionKey('/settings/server')).toBe('device');
        expect(resolveSelectedHomeCollectionKey('/settings/server/device')).toBe('device');
        expect(resolveSelectedHomeCollectionKey('/settings/server/add')).toBe('homeDraft');
        expect(resolveSelectedHomeCollectionKey('/settings/server/groups/new')).toBe('groupDraft');
        expect(resolveSelectedHomeCollectionKey('/settings/server/groups/g1')).toBe('group:g1');
        expect(resolveSelectedHomeCollectionKey(homeCollectionHref('srv id/1'))).toBe('home:srv id/1');
        expect(resolveSelectedHomeCollectionKey('/settings/machines')).toBeNull();
    });
});
