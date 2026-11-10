import { afterEach, describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { t } from '@/text';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { captureMachinePresenceObservation, clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import {
    buildMachineAddHref,
    buildMachineCollection,
    partitionMachineCollectionRailRows,
    machineCollectionHref,
    machinePageHref,
    machinesIndexHref,
    resolveSelectedMachineCollectionKey,
    machineCollectionRowKey,
    machinePresetCollectionHref,
    machinePresetCollectionRowKey,
    isMachineCollectionRowSelected,
    managedMachineConsentKey,
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
    return { serverId, accountScope: { serverId, accountId: 'collection-account' }, serverName: `Home ${serverId}`, machines, status: 'idle', ...overrides };
}

afterEach(() => clearMachineRequestReachabilityForTest());

it('keeps an explicit Home when the cloud entry opens outside the Machines collection', () => {
    expect(buildMachineAddHref({ path: 'create', serverId: 'notice/home' }))
        .toBe('/settings/machines/add?path=create&serverId=notice%2Fhome');
});

describe('machine collection rail partition', () => {
    it('keeps history and session runners outside the current fleet offline fold', () => {
        const collection = buildMachineCollection({ groups: [group('a', [
            machine('current', { active: false }),
            machine('previous-install', { active: false, replacedByMachineId: 'current' }),
            machine('revoked', { active: false, revokedAt: 1 }),
            machine('session-runner', { active: false, kind: 'ephemeral_session_runner' }),
        ])], groupedByHome: false });
        const rows = collection.sections.flatMap(section => section.rows);
        expect(rows).toHaveLength(4);
        expect(partitionMachineCollectionRailRows(rows, true).offline.map(row => row.machineId)).toEqual(['current']);
    });
    it('keeps a shared managed guest with its custodian alongside shared ordinary Machines', () => {
        const access = { custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'use', resourceMode: 'plain', accessState: 'ready' } as const;
        const collection = buildMachineCollection({ groups: [group('a', [
            machine('shared-guest', { isShared: true, access }),
            machine('shared-host', { isShared: true, access }), machine('own-guest'),
        ])], groupedByHome: false, managedByServerId: { a: [
            managed('shared-created', { enrolledMachineId: 'shared-guest', custodianAccountId: 'alice' }),
            managed('own-created', { enrolledMachineId: 'own-guest' }),
        ] } });
        const shared = collection.sections.find(section => section.title === t('machines.destinations.shared', { team: 'Alice' }));
        expect(shared?.rows.map(row => row.machineId).sort()).toEqual(['shared-guest', 'shared-host']);
        const created = collection.sections.find(section => section.title === t('machines.destinations.created'));
        expect(created?.rows.map(row => row.machineId)).toEqual(['own-guest']);
        expect(machineCollectionHref(shared!.rows.find(row => row.machineId === 'shared-guest')!))
            .toBe('/settings/machines/shared-guest?serverId=a');
        expect(collection.machineCount).toBe(3);
    });
    it('keeps enrolled creations in Created by Happier with their live presence and own name', () => {
        const nowMs = Date.now();
        captureMachinePresenceObservation({ serverId: 'a', accountId: 'collection-account' })(['joined']);
        const collection = buildMachineCollection({ groups: [group('a', [machine('joined', {
            displayName: 'Build box', host: 'lima-generated-host', active: true, activeAt: nowMs,
        })])], groupedByHome: false, nowMs,
            managedByServerId: { a: [managed('created', { enrolledMachineId: 'joined' })] } });
        const created = collection.sections.find(section => section.title === t('machines.destinations.created'));
        expect(created?.rows).toEqual([expect.objectContaining({ title: 'Build box', online: true, host: null })]);
        expect(collection.count).toBe(1);
        expect(machineCollectionHref(created!.rows[0]!)).toBe('/settings/machines/joined?serverId=a');
    });
    it('reserves an unread arrival slot in the group its presence already decides, so it does not move once its name is read', () => {
        const nowMs = 1_000_000_000;
        const rows = buildMachineCollection({ groups: [group('a', [machine('known'),
            machine('arrival', { metadata: null, availability: undefined }),
            machine('live-arrival', { metadata: null, availability: undefined, active: true, activeAt: nowMs })])],
            groupedByHome: false, nowMs }).sections[0]!.rows;
        expect(rows.find(row => row.machineId === 'arrival')?.hydrating).toBe(true);
        const partition = partitionMachineCollectionRailRows(rows, true);
        expect(partition.inline.map(row => row.machineId)).toEqual(['live-arrival']);
        expect(partition.offline.map(row => row.machineId).sort()).toEqual(['arrival', 'known']);
    });
    it('lands every row in its final group before the Account scope resolves: offline records fold as Offline, live ones stay up top', () => {
        const nowMs = 1_000_000_000;
        const machines = [
            machine('alpha-offline', { active: true, activeAt: 1 }),
            machine('beta-live', { active: true, activeAt: nowMs }),
            machine('gamma-offline'),
        ];
        const rows = buildMachineCollection({ groups: [group('a', machines, { accountScope: null })], groupedByHome: false, nowMs }).sections[0]!.rows;
        expect(rows.map(row => row.machineId)).toEqual(['beta-live', 'alpha-offline', 'gamma-offline']);
        expect(rows.map(row => row.status)).toEqual(['unknown', 'offline', 'offline']);
        expect(rows.some(row => row.presence === t('common.unknown'))).toBe(false);
        const partition = partitionMachineCollectionRailRows(rows, true);
        expect(partition.inline.map(row => row.machineId)).toEqual(['beta-live']);
        expect(partition.offline.map(row => row.machineId)).toEqual(['alpha-offline', 'gamma-offline']);

        const resolved = buildMachineCollection({ groups: [group('a', machines)], groupedByHome: false, nowMs }).sections[0]!.rows;
        expect(resolved.map(row => [row.machineId, row.status])).toEqual([
            ['beta-live', 'online'], ['alpha-offline', 'offline'], ['gamma-offline', 'offline'],
        ]);
    });
    it('keeps long-offline machines folded when the last online machine expires', () => {
        const nowMs = 1_000_000_000;
        const machines = [
            machine('studio', { active: true, activeAt: nowMs }),
            ...Array.from({ length: 9 }, (_, index) => machine(`retired-${index}`, {
                displayName: 'lima-happier-fresh', activeAt: 1,
            })),
        ];
        const readRows = (at: number) => buildMachineCollection({
            groups: [group('a', machines)], groupedByHome: false, nowMs: at,
        }).sections[0]!.rows;

        const mixed = partitionMachineCollectionRailRows(readRows(nowMs), true);
        expect(mixed.inline.map(machineCollectionRowKey)).toEqual(['machine:a:studio']);
        expect(mixed.offline).toHaveLength(9);

        const expiredRows = readRows(nowMs + 10 * 60_000);
        expect(expiredRows.every(row => !row.online)).toBe(true);
        const expired = partitionMachineCollectionRailRows(expiredRows, true);
        expect(expired.inline).toEqual([]);
        expect(expired.offline).toEqual(expiredRows);
    });

    it('keeps offline folds scoped to each Home and ownership group even if that group is entirely offline', () => {
        const shared = machine('shared', { isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } });
        const collection = buildMachineCollection({
            groups: [group('a', [
                ...Array.from({ length: 9 }, (_, index) => machine(`owned-${index}`)), shared,
            ]), group('b', [shared])], groupedByHome: true,
        });
        const partitions = collection.sections.map(section => partitionMachineCollectionRailRows(section.rows, true));
        expect(partitions.map(partition => partition.inline)).toEqual([[], [], []]);
        expect(partitions.map(partition => partition.offline.map(machineCollectionRowKey))).toEqual([
            Array.from({ length: 9 }, (_, index) => `machine:a:owned-${index}`), ['machine:a:shared'], ['machine:b:shared'],
        ]);
    });

    it('keeps short rails inline and does not create an empty fold for an online or empty section', () => {
        const rows = buildMachineCollection({
            groups: [group('a', [machine('offline')])], groupedByHome: false,
        }).sections[0]!.rows;
        expect(partitionMachineCollectionRailRows(rows, false)).toEqual({ inline: rows, offline: [] });
        const online = buildMachineCollection({
            groups: [group('a', [machine('online', { active: true, activeAt: Date.now() })])], groupedByHome: false,
        }).sections[0]!.rows;
        expect(partitionMachineCollectionRailRows(online, true)).toEqual({ inline: online, offline: [] });
        expect(partitionMachineCollectionRailRows([], true)).toEqual({ inline: [], offline: [] });
    });
});

describe('buildMachineCollection', () => {
    it('never presents a recently present machine as online after that Home cannot reach it', () => {
        const present = machine('unreachable', { active: true, activeAt: Date.now() });
        recordMachineRequestFailed({ serverId: 'a', accountId: 'collection-account', machineId: present.id, observedAtMs: Date.now() + 1 });

        const row = buildMachineCollection({ groups: [group('a', [present])], groupedByHome: false })
            .sections.flatMap(section => section.rows)[0];

        expect(row).toMatchObject({ kind: 'machine', machineId: present.id, online: false });
        expect(row?.presence).not.toBe(t('settingsOverview.machineOnline'));
    });

    it('contracts enrolled managed rows without discarding observed retained sleep or borrowing another Home power', () => {
        const stopped = managed('retained', { enrolledMachineId: 'guest', wakeOnAcceptedMessage: true,
            retention: { kind: 'unused', afterMs: 3600000, effect: 'stop' },
            observation: { observedAt: 10, availability: 'present', power: 'stopped', storage: 'retained' } });
        const collection = buildMachineCollection({ groups: [group('a', [machine('guest')]), group('b', [machine('guest')])], groupedByHome: true,
            managedByServerId: { a: [stopped] } });
        const rows = collection.sections.flatMap(section => section.rows);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ kind: 'machine', machineId: 'guest', online: false, presence: t('managedPower.asleep') });
        expect(rows[1]?.presence).not.toBe(t('managedPower.asleep'));
    });
    it('reopens archived recovery from its retained managed id even after enrollment', () => {
        const collection = buildMachineCollection({ groups: [group('a', [machine('joined')])], groupedByHome: false,
            managedByServerId: { a: [managed('retired', { archivedAt: 1, enrolledMachineId: 'joined',
                cleanup: { disposition: 'unavailable', reason: 'plugin_removed' } })] } });
        const row = collection.sections.flatMap(section => section.rows).find(row => row.kind === 'managed');
        expect(row).toMatchObject({ kind: 'managed', managedId: 'retired', serverId: 'a' });
        expect(collection.sections.find(section => section.rows.includes(row!))?.archived).toBe(true);
        expect(machineCollectionHref(row!)).toBe('/settings/machines/managed/retired?serverId=a');
        expect(collection.machineCount).toBe(0);
        expect(collection.count).toBe(1);
    });
    it.each([false, true])('opens a confirmed-absent enrolled resource at its retained receipt (Machine retained: %s)', retained => {
        const collection = buildMachineCollection({ groups: [group('a', retained ? [machine('deleted-guest')] : [])], groupedByHome: false,
            managedByServerId: { a: [managed('removed', { allocation: 'confirmed-absent', enrolledMachineId: 'deleted-guest',
                desired: 'delete', observation: { observedAt: 20, availability: 'absent' } })] } });
        const row = collection.sections.flatMap(section => section.rows)[0]!;
        expect(row).toMatchObject({ kind: 'managed', managedId: 'removed', presence: t('managedPower.resourceAbsent') });
        expect(machineCollectionHref(row)).toBe('/settings/machines/managed/removed?serverId=a');
        expect(machineCollectionHref(row, 'rail')).toBe('/machines/managed/removed?serverId=a');
    });
    it('moves ended created machines into Archive, but keeps one whose cleanup is still open in the live list', () => {
        const collection = buildMachineCollection({ groups: [group('a', [])], groupedByHome: false,
            managedByServerId: { a: [managed('live'),
                managed('gone', { allocation: 'confirmed-absent', desired: 'delete', observation: { observedAt: 20, availability: 'absent' } }),
                managed('never', { creationState: 'canceled', allocation: 'confirmed-absent', resource: undefined, desired: 'delete' }),
                managed('cleaning', { desired: 'delete', observation: { observedAt: 20, availability: 'absent' },
                    cleanup: { disposition: 'unavailable', reason: 'plugin_removed' } })] } });
        const ids = (archived: boolean) => collection.sections.filter(section => Boolean(section.archived) === archived)
            .flatMap(section => section.rows).map(row => row.kind === 'managed' ? row.managedId : row.machineId).sort();
        expect(ids(false)).toEqual(['cleaning', 'live']);
        expect(ids(true)).toEqual(['gone', 'never']);
        expect(collection.machineCount).toBe(2);
    });
    it('tells same-named created Machines apart across enrolled, pending and ended rows', () => {
        const collection = buildMachineCollection({ groups: [group('a', [machine('guest-1234', { host: 'provider-generated' })])],
            groupedByHome: false, managedByServerId: { a: [
                managed('created-joined', { enrolledMachineId: 'guest-1234' }),
                managed('cua1-pending'),
                managed('cua2-ended', { allocation: 'confirmed-absent', desired: 'delete' }),
            ] } });
        const active = collection.sections.filter(section => !section.archived).flatMap(section => section.rows);
        const archived = collection.sections.filter(section => section.archived).flatMap(section => section.rows);
        expect(active.map(row => row.title).sort()).toEqual(['Build box · cua1', 'Build box · gues']);
        expect(archived.map(row => row.title)).toEqual(['Build box · cua2']);
        expect(collection.machineCount).toBe(2);
        expect(buildMachineCollection({ groups: [group('a', [machine('guest-1234')])], groupedByHome: false,
            managedByServerId: { a: [managed('created-joined', { enrolledMachineId: 'guest-1234' }), managed('cua1-pending'),
                managed('cua2-ended', { allocation: 'confirmed-absent' })] }, query: 'cua2' }).sections.flatMap(section => section.rows))
            .toEqual([expect.objectContaining({ managedId: 'cua2-ended', title: 'Build box · cua2' })]);
    });
    it('counts machines, never presets or retired created machines, so the header agrees with its groups', () => {
        const preset: ManagedMachinePresetV1 = { id: 'recipe', homeId: 'home-a', revision: 1, name: 'Build recipe',
            owner: { kind: 'account', accountId: 'owner' }, launch: managed('m').launch, controller: managed('m').controller };
        const collection = buildMachineCollection({ groups: [group('a', [machine('mine'), machine('other')])], groupedByHome: false,
            managedByServerId: { a: [managed('pending'), managed('retired', { archivedAt: 0 })] }, presetsByServerId: { a: [preset] } });
        const liveRows = collection.sections.filter(section => !section.archived).flatMap(section => section.rows);
        expect(liveRows).toHaveLength(3);
        expect(collection.machineCount).toBe(3);
    });
    it('reserves only the unread row when a name arrives beside hydrated machines', () => {
        const ready = buildMachineCollection({ groups: [group('a', [machine('mine')])], groupedByHome: false });
        expect(ready.firstAnswerPending).toBe(false);
        const hydrating = buildMachineCollection({ groups: [group('a', [machine('mine'), machine('new', { metadata: null, availability: undefined })])], groupedByHome: false });
        expect(hydrating.firstAnswerPending).toBe(false);
        expect(hydrating.sections.flatMap(section => section.rows).filter(row => row.hydrating)).toHaveLength(1);
        const pending = buildMachineCollection({ groups: [group('a', [machine('new', { metadata: null, availability: undefined })])], groupedByHome: false });
        expect(pending.firstAnswerPending).toBe(true);
    });
    it('titles the machines Happier created, beside your own machines', () => {
        const collection = buildMachineCollection({ groups: [group('a', [machine('mine')])], groupedByHome: false,
            managedByServerId: { a: [managed('pending')] } });
        expect(collection.sections.map(section => section.title)).toEqual([t('machines.destinations.yours'), t('machines.destinations.created')]);
    });
    it('says a creation is waiting on the user while its installer holds their consent', () => {
        const input = { groups: [group('a', [])], groupedByHome: false, managedByServerId: { a: [managed('pending'), managed('other')] } };
        const presence = (collection: ReturnType<typeof buildMachineCollection>) => Object.fromEntries(collection.sections
            .flatMap(section => section.rows).map(row => [row.kind === 'managed' ? row.managedId : row.machineId, row.presence]));
        const waiting = presence(buildMachineCollection({ ...input, awaitingConsent: new Set([managedMachineConsentKey('a', 'pending')]) }));
        expect(waiting.pending).toBe(t('approvals.waitingForYou'));
        expect(waiting.other).toBe(presence(buildMachineCollection(input)).other);
        expect(presence(buildMachineCollection(input)).pending).not.toBe(t('approvals.waitingForYou'));
    });
    it('gives an ended created machine one short rail word while its full line stays the presence (UIR5c)', () => {
        const collection = buildMachineCollection({ groups: [group('a', [])], groupedByHome: false,
            managedByServerId: { a: [managed('ended', { allocation: 'confirmed-absent', creationState: 'canceled' }), managed('live')] } });
        const rows = collection.sections.flatMap(section => section.rows);
        expect(rows.find(row => row.managedId === 'ended')).toMatchObject({ presence: t('managedPower.resourceAbsent'), presenceWord: t('managedPower.ended') });
        expect(rows.find(row => row.managedId === 'live')).not.toHaveProperty('presenceWord');
    });
    it('names preset audiences from the exact Home and owner rather than the operation label', () => {
        const preset: ManagedMachinePresetV1 = { id: 'recipe', homeId: 'home-a', revision: 1, name: 'Build recipe',
            owner: { kind: 'team', teamId: 'same-id' }, launch: managed('m').launch, controller: managed('m').controller };
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
    it('keeps accessible presets separate from actual machines and scopes archive/search navigation to their Home', () => {
        const preset: ManagedMachinePresetV1 = { id: 'recipe /', homeId: 'home-a', revision: 2, name: 'Build recipe',
            owner: { kind: 'account', accountId: 'owner' }, launch: managed('m').launch, controller: managed('m').controller };
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
        expect(rows.map(row => machineCollectionHref(row))).toEqual(['/settings/machines/managed/pending?serverId=a', '/settings/machines/managed/pending?serverId=b']);
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
        expect(collection.sections.flatMap(section => section.rows.map(row => machineCollectionHref(row)))).toEqual(['/settings/machines/joined?serverId=a']);
        const waitingForMachine = buildMachineCollection({ groups: [group('a', [])], groupedByHome: false,
            managedByServerId: { a: [managed('pending', { enrolledMachineId: 'joined' })] } });
        expect(machineCollectionHref(waitingForMachine.sections[0]!.rows[0]!)).toBe('/settings/machines/managed/pending?serverId=a');
        expect(machineCollectionHref(waitingForMachine.sections[0]!.rows[0]!, 'rail')).toBe('/machines/managed/pending?serverId=a');
    });
    it('drops the groups a typed query leaves empty, but keeps them all when nothing matches', () => {
        const input = { groups: [group('a', [machine('own', { displayName: 'Studio' })])], groupedByHome: false,
            managedByServerId: { a: [managed('pending', { launch: { ...managed('pending').launch, name: 'Build box' } })] } };
        const matched = buildMachineCollection({ ...input, query: 'build' });
        expect(matched.sections.map(section => section.rows.length)).toEqual([1]);
        // With no match anywhere, each group stays so the list can say so, instead of vanishing.
        expect(buildMachineCollection({ ...input, query: 'zzz' }).sections.length).toBeGreaterThan(1);
        expect(buildMachineCollection(input).sections.length).toBeGreaterThan(1);
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
        expect(collection.sections.flatMap((section) => section.rows.map(row => machineCollectionHref(row)))).toEqual([
            '/settings/machines/shared?serverId=a', '/settings/machines/shared?serverId=b',
        ]);
    });
    it('lists one section, Your machines, for a single Home, named and sorted by what the user sees', () => {
        const collection = buildMachineCollection({
            groups: [group('a', [machine('m2', { host: 'zeta.local' }), machine('m1', { displayName: 'Alpha', platform: 'darwin' })])],
            groupedByHome: false,
            nowMs: 0,
        });
        expect(collection.count).toBe(2);
        expect(collection.sections).toHaveLength(1);
        // Labelled even alone (lab R): the list opens under Defaults, so its machines say whose they are.
        expect(collection.sections[0]?.title).toBe(t('machines.destinations.yours'));
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

    it('opens on the machines that can work: online first, then the rest, each by name (lab R)', () => {
        const nowMs = 1_000_000_000;
        const collection = buildMachineCollection({
            groups: [group('a', [
                machine('m-a', { displayName: 'Atlas', active: false, activeAt: 1 }),
                machine('m-z', { displayName: 'Zephyr', active: true, activeAt: nowMs }),
                machine('m-b', { displayName: 'Birch', active: false, activeAt: 1 }),
                machine('m-m', { displayName: 'Maple', active: true, activeAt: nowMs }),
            ])],
            groupedByHome: false,
            nowMs,
        });
        expect(collection.sections[0]!.rows.map(row => [row.title, row.online])).toEqual([
            ['Maple', true], ['Zephyr', true], ['Atlas', false], ['Birch', false],
        ]);
    });

    it('keeps the part that tells two same-named machines apart separate from the name, for a one-line row', () => {
        const collection = buildMachineCollection({
            groups: [group('s1', [
                machine('f98b860d-63e0', { displayName: 'lima-happier-fresh', host: 'lima-happier-fresh' }),
                machine('0c1d2e3f-9999', { displayName: 'lima-happier-fresh', host: 'lima-happier-fresh' }),
                machine('solo', { displayName: 'Studio' }),
            ])],
            groupedByHome: false,
        });
        const rows = collection.sections[0]!.rows;
        expect(rows.map(row => [row.titleParts.name, row.titleParts.hint, row.title])).toEqual([
            ['lima-happier-fresh', '0c1d', 'lima-happier-fresh · 0c1d'],
            ['lima-happier-fresh', 'f98b', 'lima-happier-fresh · f98b'],
            ['Studio', null, 'Studio'],
        ]);
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

    it('builds every machine-page link inside the door it was opened from', () => {
        expect(machinesIndexHref('rail')).toBe('/machines');
        expect(machinesIndexHref('settings')).toBe('/settings/machines');
        expect(machinePageHref({ door: 'rail', target: { machineId: 'm 1', serverId: 'srv/a' } })).toBe('/machines/m%201?serverId=srv%2Fa');
        expect(machinePageHref({ door: 'settings', target: { machineId: 'm1' }, page: 'doctor' })).toBe('/settings/machines/m1/doctor');
        // Overview is the page itself: it never names itself in the link.
        expect(machinePageHref({ door: 'rail', target: { machineId: 'm1', serverId: 'a' }, tab: { id: 'overview' } })).toBe('/machines/m1?serverId=a');
        expect(machineCollectionHref({ machineId: 'm1', serverId: 'a' }, 'rail')).toBe('/machines/m1?serverId=a');
        expect(machineCollectionHref({ kind: 'managed', managedId: 'p', serverId: 'a' }, 'rail')).toBe('/machines/managed/p?serverId=a');
        expect(machineCollectionHref({ kind: 'managed', managedId: 'p', enrolledMachineId: 'm1', serverId: 'a' }, 'rail')).toBe('/machines/m1?serverId=a');
        // Configuration (presets) has one home: the Settings door.
        expect(machineCollectionHref({ kind: 'preset', presetId: 'r', serverId: 'a' }, 'rail')).toBe('/settings/machines/presets/r?serverId=a');
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
        // Both doors' index routes select "All machines", the list's first row.
        expect(resolveSelectedMachineCollectionKey('/settings/machines', {})).toBe('allMachines');
        expect(resolveSelectedMachineCollectionKey('/machines', {})).toBe('allMachines');
        // A machine's sub-page keeps its machine selected, in either door.
        expect(resolveSelectedMachineCollectionKey('/machines/m2', { serverId: 'a' })).toBe('machine:a:m2');
        expect(resolveSelectedMachineCollectionKey('/machines/m2/terminal', { serverId: 'a' })).toBe('machine:a:m2');
        expect(resolveSelectedMachineCollectionKey('/settings/machines/m2/doctor', {})).toBe('machine::m2');
        expect(resolveSelectedMachineCollectionKey('/machines/managed/p', { serverId: 'a' })).toBe('managed:a:p');
        expect(resolveSelectedMachineCollectionKey('/machine/m2', {})).toBeNull();
    });
});
