import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { t } from '@/text';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import {
    buildMachineCollection,
    machineCollectionHref,
    resolveMachineCollectionLandingHref,
    resolveSelectedMachineCollectionKey,
    machineCollectionRowKey,
    machinePresetCollectionHref,
    machinePresetCollectionRowKey,
    isMachineCollectionRowSelected,
} from './machineCollectionModel';

function managed(id: string, overrides: Partial<ManagedMachineV1> = {}): ManagedMachineV1 {
    return { id, homeId: 'home-a', custodianAccountId: 'owner',
        launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build box', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
        resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { nativeId: 'resource' } },
        desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, ...overrides };
}

function machine(id: string, overrides: Partial<Machine> & { displayName?: string; host?: string; platform?: string } = {}): Machine {
    const { displayName, host, platform, ...rest } = overrides;
    const fixture = createMachineFixture({ id });
    return {
        ...fixture,
        active: false,
        activeAt: 0,
        metadata: { ...fixture.metadata!, displayName, host: host ?? `${id}.local`, platform: platform ?? 'linux' },
        ...rest,
    };
}

function group(serverId: string, machines: Machine[], overrides: Partial<ActiveSelectionMachineGroup> = {}): ActiveSelectionMachineGroup {
    return { serverId, serverName: `Home ${serverId}`, machines, status: 'idle', ...overrides };
}

describe('buildMachineCollection', () => {
    it('names preset audiences from the exact Home and owner rather than the operation label', () => {
        const preset: ManagedMachinePresetV1 = { id: 'recipe', homeId: 'home-a', revision: 1, name: 'Build recipe',
            owner: { kind: 'team', teamId: 'same-id' }, recipe: managed('m').launch, controller: managed('m').controller };
        const collection = buildMachineCollection({ groups: [group('a', []), group('b', [])], groupedByHome: true,
            presetsByServerId: { a: [preset, { ...preset, id: 'personal', owner: { kind: 'account', accountId: 'owner' } }], b: [preset] },
            teamNamesByServerId: { a: { 'same-id': 'Design' }, b: { 'same-id': 'Engineering' } } });
        expect(Object.fromEntries(collection.presetSections[0]!.rows.map(row => [row.presetId, row.audience])))
            .toEqual({ recipe: 'Design', personal: t('machinePresets.ownerPersonal') });
        expect(collection.presetSections[1]?.rows[0]?.audience).toBe('Engineering');
    });
    it('omits an unavailable custodian suffix instead of inventing an Unknown owner', () => {
        const collection = buildMachineCollection({ groups: [group('a', [machine('shared', { isShared: true })])], groupedByHome: false });
        expect(collection.sections[0]?.title).toBe(t('machines.destinations.sharedWithoutOwner'));
    });
    it('keeps accessible recipes separate from actual machines and scopes archive/search navigation to their Home', () => {
        const preset: ManagedMachinePresetV1 = { id: 'recipe /', homeId: 'home-a', revision: 2, name: 'Build recipe',
            owner: { kind: 'account', accountId: 'owner' }, recipe: managed('m').launch, controller: managed('m').controller };
        const collection = buildMachineCollection({ groups: [group('a', []), group('b', [])], groupedByHome: true,
            presetsByServerId: { a: [preset, { ...preset, id: 'archived', archivedAt: 0 }], b: [{ ...preset, homeId: 'home-b' }] }, query: 'BUILD' });
        expect(collection.sections.flatMap(section => section.rows)).toEqual([]);
        expect(collection.presetSections.map(section => section.rows.map(machinePresetCollectionRowKey))).toEqual([
            ['preset:a:recipe /', 'preset:a:archived'], ['preset:b:recipe /'],
        ]);
        expect(machinePresetCollectionHref(collection.presetSections[0]!.rows[0]!)).toBe('/settings/machines/presets/recipe%20%2F?serverId=a');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/presets/recipe%20%2F', { serverId: 'a' })).toBe('preset:a:recipe /');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/presets/new', { serverId: 'a' })).toBe('presetDraft:a');
        expect(buildMachineCollection({ groups: [group('a', [])], groupedByHome: false, presetsByServerId: { a: [preset] }, query: 'missing' }).presetSections[0]?.rows).toEqual([]);
    });
    it('keeps a paid pending resource reopenable without a Machine id, including unavailable cleanup', () => {
        const collection = buildMachineCollection({ groups: [group('a', []), group('b', [])], groupedByHome: true,
            managedByServerId: { a: [managed('pending', { cleanup: { disposition: 'unavailable', reason: 'plugin_removed' } })],
                b: [managed('pending', { homeId: 'home-b' })] } });
        const rows = collection.sections.flatMap(section => section.rows);
        expect(collection.count).toBe(2);
        expect(rows.map(machineCollectionRowKey)).toEqual(['managed:a:pending', 'managed:b:pending']);
        expect(rows.map(machineCollectionHref)).toEqual(['/settings/machines/managed/pending?serverId=a', '/settings/machines/managed/pending?serverId=b']);
        expect(rows[0]).toMatchObject({ kind: 'managed', managedId: 'pending', title: 'Build box' });
        expect(rows[0]).not.toHaveProperty('machineId');
        expect(isMachineCollectionRowSelected('managed:a:pending', rows[0]!)).toBe(true);
        expect(isMachineCollectionRowSelected('managed:a:pending', rows[1]!)).toBe(false);
        expect(isMachineCollectionRowSelected('managed::pending', rows[0]!)).toBe(false);
    });

    it('filters managed names and hands enrolled rows to the ordinary owner without duplicating a Machine', () => {
        const collection = buildMachineCollection({ groups: [group('a', [machine('joined', { displayName: 'Build box' })])], groupedByHome: false,
            managedByServerId: { a: [managed('pending', { enrolledMachineId: 'joined' }), managed('other', { launch: { ...managed('other').launch, name: 'Other' } })] }, query: 'BUILD' });
        expect(collection.count).toBe(1);
        expect(collection.sections.flatMap(section => section.rows.map(machineCollectionHref))).toEqual(['/settings/machines/joined?serverId=a']);
        const waitingForMachine = buildMachineCollection({ groups: [group('a', [])], groupedByHome: false,
            managedByServerId: { a: [managed('pending', { enrolledMachineId: 'joined' })] } });
        expect(machineCollectionHref(waitingForMachine.sections[0]!.rows[0]!)).toBe('/settings/machines/joined?serverId=a');
    });
    it('groups accessible shared Machines under their real custodian without changing exact Home navigation', () => {
        const collection = buildMachineCollection({
            groups: [group('a', [machine('own'), machine('shared', {
                isShared: true, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
                    role: 'use', resourceMode: 'plain', accessState: 'ready' },
            })])], groupedByHome: false,
        });
        expect(collection.sections).toHaveLength(2);
        expect(collection.sections[1]?.title).toBe(t('machines.destinations.shared', { team: 'Alice' }));
        expect(collection.sections[1]?.rows[0]).toMatchObject({ machineId: 'shared', serverId: 'a',
            ownership: t('machines.destinations.owner', { owner: 'Alice', platform: 'Linux' }) });
        expect(machineCollectionHref(collection.sections[1]!.rows[0]!)).toBe('/settings/machines/shared?serverId=a');
    });
    it('preserves Home scope when two Homes expose the same shared Machine identifier', () => {
        const shared = machine('shared', { isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } });
        const collection = buildMachineCollection({ groups: [group('a', [shared]), group('b', [shared])], groupedByHome: true });
        expect(new Set(collection.sections.map((section) => section.key)).size).toBe(2);
        expect(collection.sections[0]?.title).toContain('Home a');
        expect(collection.sections[1]?.title).toContain('Home b');
        expect(collection.sections.flatMap((section) => section.rows.map(machineCollectionHref))).toEqual([
            '/settings/machines/shared?serverId=a', '/settings/machines/shared?serverId=b',
        ]);
    });
    it('lists one ungrouped section for a single Home, named and sorted by what the user sees', () => {
        const collection = buildMachineCollection({
            groups: [group('a', [machine('m2', { host: 'zeta.local' }), machine('m1', { displayName: 'Alpha', platform: 'darwin' })])],
            groupedByHome: false,
            nowMs: 0,
        });
        expect(collection.count).toBe(2);
        expect(collection.sections).toHaveLength(1);
        expect(collection.sections[0]?.title).toBeNull();
        expect(collection.sections[0]?.rows.map((row) => [row.title, row.platformLabel])).toEqual([
            ['Alpha', 'macOS'],
            ['zeta.local', 'Linux'],
        ]);
    });

    it('groups by Home only when several Homes are visible, keeping empty Homes with their status', () => {
        const collection = buildMachineCollection({
            groups: [group('a', [machine('m1')]), group('b', [], { status: 'signedOut' })],
            groupedByHome: true,
            nowMs: 0,
        });
        expect(collection.sections.map((section) => [section.title, section.rows.length, section.status])).toEqual([
            ['Home a', 1, 'idle'],
            ['Home b', 0, 'signedOut'],
        ]);
    });

    it('tells two machines with the same name apart in the list', () => {
        const collection = buildMachineCollection({
            groups: [group('s1', [
                machine('f98b860d-63e0', { displayName: 'lima-happier-fresh', host: 'lima-happier-fresh' }),
                machine('0c1d2e3f-9999', { displayName: 'lima-happier-fresh', host: 'lima-happier-fresh' }),
            ])],
            groupedByHome: false,
        });
        const titles = collection.sections[0]!.rows.map((row) => row.title);
        expect(new Set(titles).size).toBe(2);
    });

    it("reads each row's presence line from the shared presence owner", () => {
        const collection = buildMachineCollection({
            groups: [group('s1', [machine('m-1', { displayName: 'Studio', active: false, activeAt: 1 })])],
            groupedByHome: false,
        });
        expect(collection.sections[0]!.rows[0]!.presence).toMatch(/Offline/);
    });

    it('lists a machine whose details cannot be read as locked, never by its id', () => {
        const collection = buildMachineCollection({
            groups: [group('s1', [machine('f98b860d-63e0', { metadata: null,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' } })])],
            groupedByHome: false,
        });
        const row = collection.sections[0]!.rows[0]!;
        expect(row.title).toBe(t('machine.lockedMachine'));
        expect(row.title).not.toContain('f98b');
    });

    it('gives a locked machine the reason it cannot be read', () => {
        const collection = buildMachineCollection({
            groups: [group('s1', [{
                ...machine('f98b860d-63e0'),
                metadata: null,
                availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
            } as unknown as Machine])],
            groupedByHome: false,
        });
        expect(collection.sections[0]!.rows[0]!.reason).toBe(t('machine.lockedReason.missingKey'));
    });

    it('filters by name or host when a query is typed', () => {
        const collection = buildMachineCollection({
            groups: [group('a', [machine('m1', { displayName: 'Build box', host: 'ci.internal' }), machine('m2', { host: 'laptop.local' })])],
            groupedByHome: false,
            query: 'CI',
            nowMs: 0,
        });
        expect(collection.sections[0]?.rows.map((row) => row.machineId)).toEqual(['m1']);
    });
});

describe('machine collection navigation', () => {
    const collection = buildMachineCollection({
        groups: [group('a', [machine('m1', { displayName: 'Alpha' }), machine('m2', { displayName: 'Beta' })])],
        groupedByHome: false,
        nowMs: 0,
    });

    it('opens a machine inside the collection, scoped to its Home', () => {
        expect(machineCollectionHref({ machineId: 'm 1', serverId: 'srv/a' })).toBe('/settings/machines/m%201?serverId=srv%2Fa');
    });

    it('lands on the last visited machine, then the first machine', () => {
        expect(resolveMachineCollectionLandingHref({ collection, lastVisited: { machineId: 'm2', serverId: 'a' }, isDesktop: false }))
            .toBe('/settings/machines/m2?serverId=a');
        expect(resolveMachineCollectionLandingHref({ collection, lastVisited: { machineId: 'gone', serverId: 'a' }, isDesktop: false }))
            .toBe('/settings/machines/m1?serverId=a');
    });

    it('lands on this computer on desktop, else on adding a machine, when there are no machines', () => {
        const empty = buildMachineCollection({ groups: [group('a', [])], groupedByHome: false, nowMs: 0 });
        expect(resolveMachineCollectionLandingHref({ collection: empty, lastVisited: null, isDesktop: true })).toBe('/settings/machines/this-computer');
        expect(resolveMachineCollectionLandingHref({ collection: empty, lastVisited: null, isDesktop: false })).toBe('/settings/machines/add');
    });

    it('selects the row the route names', () => {
        expect(resolveSelectedMachineCollectionKey('/settings/machines/managed/pending%20id', { serverId: 'a' })).toBe('managed:a:pending id');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/m2', { serverId: 'a' })).toBe('machine:a:m2');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/m2', {})).toBe('machine::m2');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/this-computer', {})).toBe('thisComputer');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/defaults', {})).toBe('defaults');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/pools/p1', { serverId: 'a' })).toBe('pool:a:p1');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/pools/new', { serverId: 'a' })).toBe('poolDraft:a');
        // The machine being added is the collection's draft row (lab M4).
        expect(resolveSelectedMachineCollectionKey('/settings/machines/add', {})).toBe('machineDraft');
        expect(resolveSelectedMachineCollectionKey('/settings/machines', {})).toBeNull();
    });
});
