import { describe, expect, it } from 'vitest';

import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerSelectionGroup } from '@/sync/domains/server/selection/serverSelectionTypes';
import { t } from '@/text';

import {
    buildHomeCollection,
    describeHomeRow,
    describeHomeStatus,
    homeCollectionHref,
    resolveSelectedHomeCollectionKey,
} from './homeCollectionModel';

function profile(id: string, overrides: Partial<ServerProfile> = {}): ServerProfile {
    return { id, name: '', serverUrl: `https://${id}.example.test`, ...overrides } as unknown as ServerProfile;
}

describe('buildHomeCollection', () => {
    it('distinguishes unnamed peer Homes in their visible titles even when health occupies the status slot', () => {
        const collection = buildHomeCollection({
            servers: [profile('home-a'), profile('home-b')], groups: [], activeServerId: 'home-a',
            activeTargetKey: null, deviceDefaultServerId: null,
            authStatusByServerId: { 'home-a': 'signedIn', 'home-b': 'signedOut' },
            homeConnectionSummaryByServerId: {},
        });
        expect(collection.homes.map((row) => row.title)).toEqual([
            t('settingsAccount.thisHomeTitle'), 'https://home-b.example.test',
        ]);
        for (const row of collection.homes) {
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

describe('Home row status', () => {
    const summary = (kind: string, statusKey: string) => ({ kind, statusKey, statusLabelKey: 'status.unknown', action: 'none' }) as never;
    const homes = (kinds: Record<string, [string, string]>) => buildHomeCollection({
        servers: Object.keys(kinds).map((id) => profile(id, { name: id })), groups: [], activeServerId: 'connected',
        activeTargetKey: null, deviceDefaultServerId: null, authStatusByServerId: {},
        homeConnectionSummaryByServerId: Object.fromEntries(Object.entries(kinds).map(([id, [kind, key]]) => [id, summary(kind, key)])),
    }).homes;

    it('says a Home that needs sign-in or cannot be reached in the status slot, and keeps a healthy Home quiet', () => {
        const rows = homes({ connected: ['connected', 'connected'], signIn: ['sign_in', 'action_required'],
            down: ['unavailable', 'error'], retry: ['reconnecting', 'connecting'], mystery: ['unknown', 'unknown'] });
        const status = (id: string) => describeHomeStatus(rows.find((row) => row.id === id)!)?.status ?? null;
        expect(status('connected')).toBeNull();
        expect(status('signIn')).toBe('signIn');
        expect(status('down')).toBe('failed');
        expect(status('retry')).toBe('offline');
        expect(status('mystery')).toBeNull();
    });

    it('does not repeat the status word on the context line', () => {
        const [row] = homes({ signIn: ['sign_in', 'action_required'] });
        expect(describeHomeStatus(row!)?.label).toBeTruthy();
        expect(describeHomeRow(row!)).not.toContain(describeHomeStatus(row!)!.label);
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
