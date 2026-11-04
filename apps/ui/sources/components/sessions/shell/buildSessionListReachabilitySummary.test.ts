import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as workspaceDisplay from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';

import {
    buildSessionListReachabilitySummary,
    createSessionListReachabilitySummaryCache,
} from './buildSessionListReachabilitySummary';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { removeServerProfile, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { getSessionAvatarId, getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import { buildSessionListViewData } from '@/sync/domains/session/listing/sessionListViewData';
import { buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import { t } from '@/text';

describe('buildSessionListReachabilitySummary', () => {
    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previousState = storage.getState();
        storage.setState({ sessions: {}, machines: {}, machineListByServerId: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
        projectManager.clear();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        storage.setState(previousState, true);
        projectManager.clear();
    });

    it('reorders 1000 existing displays without resolving their targets again and still sees a simultaneous Machine edit', async () => {
        const profile = await upsertServerProfile({ serverUrl: 'https://display-reorder-cost.example.test', name: 'Display reorder cost' });
        const machines = Array.from({ length: 10 }, (_, index) => createMachineFixture({ id: `reorder-machine-${index}` }));
        const rows = Array.from({ length: 1_000 }, (_, index) => buildSessionListRenderableFromSession(createSessionFixture({
            id: `reorder-session-${index}`, serverId: profile.id,
            metadata: { machineId: machines[index % machines.length]!.id, path: `/repo-${index}`, host: `host-${index % machines.length}` },
        })));
        const byId = Object.fromEntries(rows.map(session => [session.id, session]));
        const input = {
            cache: createSessionListReachabilitySummaryCache(),
            listItems: rows.map(session => ({ type: 'session' as const, serverId: profile.id, sessionId: session.id })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])),
            workspaceRefs: [],
            resolveSessionRenderable: (item: { sessionId: string }) => byId[item.sessionId] ?? null,
        };
        try {
            storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
                sessionListRowsByServerId: { [profile.id]: byId } });
            const initial = buildSessionListReachabilitySummary(input);
            const derive = vi.spyOn(workspaceDisplay, 'resolveSessionWorkspaceDisplayPresentation');
            input.listItems = [...input.listItems].reverse().map(item => ({ ...item }));
            const reordered = buildSessionListReachabilitySummary(input);
            expect([...reordered.displayById.keys()]).toEqual([...rows].reverse().map(session => session.id));
            expect(reordered.displayById.get(rows[0]!.id)).toBe(initial.displayById.get(rows[0]!.id));
            expect(derive).toHaveBeenCalledTimes(0);

            const changed = { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Renamed during reorder' } };
            input.machinesById.set(changed.id, changed);
            storage.setState(state => ({ machines: { ...state.machines, [changed.id]: changed } }));
            input.listItems = [...input.listItems].reverse().map(item => ({ ...item }));
            const renamed = buildSessionListReachabilitySummary(input);
            expect(renamed.displayById.get(rows[0]!.id)?.machineLabel).toBe('Renamed during reorder');
            expect(renamed.displayById.get(rows[1]!.id)).toBe(initial.displayById.get(rows[1]!.id));
            expect(derive).toHaveBeenCalledTimes(100);
        } finally {
            await removeServerProfile(profile.id);
        }
    });

    it('derives only the dependent Session rows for one changed Machine', () => {
        const machines = Array.from({ length: 10 }, (_, i) => createMachineFixture({ id: `keyed-${i}` }));
        const rows = Array.from({ length: 50 }, (_, i) => buildSessionListRenderableFromSession(createSessionFixture({
            id: `keyed-row-${i}`, serverId: 'keyed-home', metadata: { machineId: machines[i % 10]!.id, path: `/repo-${i}`, host: `host-${i % 10}` },
        })));
        storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            sessionListRowsByServerId: { 'keyed-home': Object.fromEntries(rows.map(row => [row.id, row])) } });
        const input = { cache: createSessionListReachabilitySummaryCache(),
            listItems: rows.map(row => ({ type: 'session' as const, serverId: 'keyed-home', sessionId: row.id })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])), workspaceRefs: [],
            resolveSessionRenderable: (item: { sessionId: string }) => rows.find(row => row.id === item.sessionId) ?? null };
        buildSessionListReachabilitySummary(input);
        // Observe the real workspace/target derivation; do not replace internal logic.
        const derive = vi.spyOn(workspaceDisplay, 'resolveSessionWorkspaceDisplayPresentation');
        const changed = { ...machines[0]!, metadata: { ...machines[0]!.metadata!, displayName: 'Changed' } };
        storage.setState(state => ({ machines: { ...state.machines, [changed.id]: changed } }));
        input.machinesById.set(changed.id, changed);
        const result = buildSessionListReachabilitySummary(input);
        expect(result.displayById.get(rows[0]!.id)?.machineLabel).toBe('Changed');
        expect(derive).toHaveBeenCalledTimes(5);
        derive.mockClear();
        rows[1] = { ...rows[1]!, metadata: { ...rows[1]!.metadata!, path: '/changed-workspace' } };
        storage.setState(state => ({ sessionListRowsByServerId: { 'keyed-home': {
            ...state.sessionListRowsByServerId['keyed-home'], [rows[1]!.id]: rows[1]!,
        } } }));
        const moved = buildSessionListReachabilitySummary(input);
        expect(moved.displayById.get(rows[1]!.id)?.workspaceSubtitle).toBe('changed-workspace');
        expect(derive).toHaveBeenCalledTimes(1);
    });

    it('keeps a foreign Home workspace instead of the hydrated same-ID Session project', async () => {
        const homeA = await upsertServerProfile({ serverUrl: 'https://workspace-a.example.test', name: 'A' });
        const homeB = await upsertServerProfile({ serverUrl: 'https://workspace-b.example.test', name: 'B' });
        await setActiveServerId(homeA.id, { scope: 'device' });
        const sessionA = createSessionFixture({ id: 'same-session', serverId: homeA.id,
            metadata: { machineId: 'machine-a', path: '/repo-a', host: 'a.local' } });
        const sessionB = createSessionFixture({ id: 'same-session', serverId: homeB.id,
            metadata: { machineId: 'machine-b', path: '/repo-b', host: 'b.local' } });
        const rowA = buildSessionListRenderableFromSession(sessionA);
        const rowB = buildSessionListRenderableFromSession(sessionB);
        const machineA = createMachineFixture({ id: 'machine-a', active: true });
        const machineB = createMachineFixture({ id: 'machine-b' });
        storage.setState({
            sessions: { [sessionA.id]: sessionA },
            machines: { [machineA.id]: machineA },
            machineListByServerId: { [homeB.id]: [machineB] },
            sessionListRowsByServerId: { [homeA.id]: { [sessionA.id]: rowA }, [homeB.id]: { [sessionB.id]: rowB } },
            ordinarySessionListMembershipByServerId: { [homeA.id]: [sessionA.id], [homeB.id]: [sessionB.id] },
        });
        // Real store/project ownership: the bare accessor materializes A's project.
        expect(storage.getState().getProjectForSession(sessionA.id)?.key.rootPath).toBe('/repo-a');
        const address = { serverId: homeB.id, sessionId: sessionB.id };
        const summary = buildSessionListReachabilitySummary({
            listItems: [{ type: 'session', ...address }],
            machinesById: new Map([[machineB.id, machineB]]),
            workspaceRefs: [],
            resolveSessionRenderable: () => rowB,
        });
        expect(summary.displayByKey.get(sessionAddressKey(address))).toMatchObject({
            machineId: 'machine-b', workspaceSubtitle: 'repo-b',
        });
        expect.soft(getSessionSubtitle(sessionB)).toBe('/repo-b');
        expect.soft(getSessionName(rowB, homeB.id)).toBe('repo-b');
        expect.soft(getSessionAvatarId(rowB, homeB.id)).toBe('machine-b:/repo-b');
        expect.soft(getSessionSubtitle(rowB, homeB.id)).toBe('/repo-b');
        expect.soft(getSessionSubtitle(createSessionFixture({
            ...sessionB,
            metadataLayoutVersion: 1,
            metadata: { machineId: 'machine-b', path: '/shared-b', host: 'b.local' },
            ownerMetadataView: { ...sessionB.metadata!, path: '/private-b' },
        }))).toBe('/private-b');
        expect.soft(getSessionSubtitle(createSessionFixture({
            ...sessionB, metadataLayoutVersion: 1, ownerMetadataView: null,
        }))).toBe(t('status.unknown'));
        const groupedRows = buildSessionListViewData({ [sessionB.id]: rowB }, { [machineB.id]: machineB }, {
            layoutV1: 'projects',
            serverScope: { serverId: homeB.id }, sessionTargetState: storage.getState(),
        });
        expect.soft(groupedRows.find((item) => item.type === 'header' && item.headerKind === 'project'))
            .toMatchObject({ title: '/repo-b' });
        const index = buildSessionListIndexWithServerScope({
            sessions: { [sessionB.id]: rowB }, sessionRecords: storage.getState().sessions,
            machines: { [machineB.id]: machineB }, machineRecords: { [machineB.id]: machineB },
            getProjectForSession: storage.getState().getProjectForSession,
            layoutV1: 'projects', serverScope: { serverId: homeB.id },
        });
        expect.soft(index.find((item) => item.type === 'header' && item.headerKind === 'project'))
            .toMatchObject({ title: '/repo-b' });
    });

    it('reuses a shared empty summary when there are no session rows', () => {
        const first = buildSessionListReachabilitySummary({
            listItems: [],
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: () => null,
        });
        const second = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey: 'server:server-a:day:2026-02-19',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: () => null,
        });

        expect(first).toBe(second);
        expect(first.displayById).toBe(second.displayById);
        expect(first.displayById.size).toBe(0);
        expect(first.hasMultipleMachines).toBe(false);
    });

    it('retains other rows when one Machine display name changes', () => {
        const rows = ['a', 'b'].map(id => buildSessionListRenderableFromSession(createSessionFixture({
            id, serverId: 'display-home', metadata: { machineId: `machine-${id}`, path: `/repo-${id}`, host: `${id}.local` },
        })));
        const machines = rows.map(row => createMachineFixture({ id: row.metadata!.machineId!,
            metadata: { ...createMachineFixture().metadata!, host: row.metadata!.host!, displayName: row.id } }));
        const input = {
            cache: createSessionListReachabilitySummaryCache(),
            listItems: rows.map(row => ({ type: 'session' as const, serverId: 'display-home', sessionId: row.id })),
            machinesById: new Map(machines.map(machine => [machine.id, machine])),
            workspaceRefs: [],
            resolveSessionRenderable: (item: { sessionId: string }) => rows.find(row => row.id === item.sessionId) ?? null,
        };
        const before = buildSessionListReachabilitySummary(input);
        input.machinesById.set(machines[0]!.id, { ...machines[0]!,
            metadata: { ...machines[0]!.metadata!, displayName: 'Changed machine' } });
        const after = buildSessionListReachabilitySummary(input);
        expect(after.displayById.get('a')?.machineLabel).toBe('Changed machine');
        expect(after.displayById.get('b')).toBe(before.displayById.get('b'));
    });

    it('refreshes the Machine label when admitted metadata is withdrawn', () => {
        const row = buildSessionListRenderableFromSession(createSessionFixture({ id: 'locked-row', serverId: 'display-home',
            metadata: { machineId: 'machine-a', path: '/repo', host: 'a.local' } }));
        const machine = createMachineFixture({ id: 'machine-a', metadata: { ...createMachineFixture().metadata!, host: 'a.local', displayName: 'Readable' } });
        const input = {
            cache: createSessionListReachabilitySummaryCache(),
            listItems: [{ type: 'session' as const, serverId: 'display-home', sessionId: row.id }],
            machinesById: new Map([[machine.id, machine]]), workspaceRefs: [], resolveSessionRenderable: () => row,
        };
        const before = buildSessionListReachabilitySummary(input);
        const locked = { ...machine, availability: { kind: 'locked' as const, reason: 'encryption_material_unavailable' as const } };
        input.machinesById.set(machine.id, locked);
        const after = buildSessionListReachabilitySummary(input);
        expect(after.displayById.get(row.id)?.machineLabel).toBe(t('machine.lockedMachine'));
        expect(after).not.toBe(before);
    });

    it('reuses the same non-empty summary for identical inputs', () => {
        const sessionRenderablesById = {
            'sess-a': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-a',
                    homeDir: '/home/user',
                },
            },
            'sess-b': {
                metadata: {
                    machineId: 'machine-b',
                    host: 'machine-b.local',
                    path: '/repo-b',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const input = {
            cache: createSessionListReachabilitySummaryCache(),
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-a',
                },
                {
                    type: 'session',
                    sessionId: 'sess-b',
                },
            ] as any,
            machinesById: new Map([
                ['machine-a', { id: 'machine-a', metadata: { host: 'machine-a.local' } }],
                ['machine-b', { id: 'machine-b', metadata: { host: 'machine-b.local' } }],
            ]),
            workspaceRefs: [],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        } as const;

        const first = buildSessionListReachabilitySummary(input);
        const second = buildSessionListReachabilitySummary(input);

        expect(first).toBe(second);
        expect(first.hasMultipleMachines).toBe(true);
        expect(first.displayById.get('sess-a')).toEqual({
            machineId: 'machine-a',
            machineLabel: 'machine-a.local',
            workspaceSubtitle: 'repo-a',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });

    it('reuses cached display rows when unrelated session rows refresh', () => {
        const renderablesById = {
            'sess-unchanged': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-unchanged',
                    homeDir: '/home/user',
                },
            },
            'sess-refreshed': {
                metadata: {
                    machineId: 'machine-a',
                    host: 'machine-a.local',
                    path: '/repo-refreshed',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const machinesById = new Map([
            ['machine-a', { id: 'machine-a', metadata: { host: 'machine-a.local' } }],
        ]);
        const listItems = [
            {
                type: 'session',
                sessionId: 'sess-unchanged',
                serverId: 'server-a',
            },
            {
                type: 'session',
                sessionId: 'sess-refreshed',
                serverId: 'server-a',
            },
        ] as any;
        const workspaceRefs: ReadonlyArray<never> = [];
        const cache = createSessionListReachabilitySummaryCache();
        const first = buildSessionListReachabilitySummary({
            cache,
            listItems,
            machinesById,
            workspaceRefs,
            resolveSessionRenderable: (item: any) => renderablesById[item.sessionId] ?? null,
        });
        const unchangedKey = sessionAddressKey({ serverId: 'server-a', sessionId: 'sess-unchanged' });
        const refreshedKey = sessionAddressKey({ serverId: 'server-a', sessionId: 'sess-refreshed' });
        const unchangedDisplay = first.displayByKey.get(unchangedKey);
        const second = buildSessionListReachabilitySummary({
            cache,
            listItems,
            machinesById,
            workspaceRefs,
            resolveSessionRenderable: (item: any) => item.sessionId === 'sess-refreshed'
                ? { ...renderablesById['sess-refreshed'], presence: 1 }
                : renderablesById[item.sessionId] ?? null,
        });

        expect(second).toBe(first);
        expect(second.displayByKey.get(unchangedKey)).toBe(unchangedDisplay);
        expect(second.displayByKey.get(refreshedKey)).toMatchObject({
            machineId: 'machine-a',
            workspaceSubtitle: 'repo-refreshed',
        });
    });

    it('keeps delimiter-bearing qualified Session addresses distinct in cache and display maps', () => {
        const addresses = [
            { serverId: 'https://home.example/a', sessionId: 'b:c' },
            { serverId: 'https://home.example/a:b', sessionId: 'c' },
        ] as const;
        const renderables = new Map(addresses.map((address, index) => [
            sessionAddressKey(address),
            { metadata: { host: `machine-${index}.local`, path: `/repo-${index}` } },
        ]));
        const summary = buildSessionListReachabilitySummary({
            listItems: addresses.map((address) => ({ type: 'session' as const, ...address })),
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: (item) => renderables.get(sessionAddressKey({
                serverId: item.serverId!,
                sessionId: item.sessionId,
            })) as any,
        });

        expect(summary.displayByKey.size).toBe(2);
        expect(summary.displayByKey.get(sessionAddressKey(addresses[0]))?.workspaceSubtitle).toBe('repo-0');
        expect(summary.displayByKey.get(sessionAddressKey(addresses[1]))?.workspaceSubtitle).toBe('repo-1');
    });

    it('preserves path subtitles even when no machine metadata is available', () => {
        const sessionRenderablesById = {
            'sess-path-only': {
                metadata: {
                    path: '/repo-only',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-path-only',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        });

        expect(summary.displayById.get('sess-path-only')).toEqual({
            machineId: null,
            machineLabel: '',
            workspaceSubtitle: 'repo-only',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
        expect(summary.hasMultipleMachines).toBe(false);
    });

    it('uses renamed workspace refs for date-grouped row subtitles', () => {
        const sessionRenderablesById = {
            'sess-renamed': {
                metadata: {
                    machineId: 'machine-stale',
                    host: 'stale.local',
                    path: '/home/user/stale-repo',
                    homeDir: '/home/user',
                },
            },
        } as any;
        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-renamed',
                    serverId: 'server-a',
                    groupKind: 'date',
                },
            ] as any,
            machinesById: new Map(),
            workspaceRefs: [
                {
                    id: 'workspace-ref-renamed',
                    serverId: 'server-a',
                    machineId: 'machine-stale',
                    rootPath: '/home/user/stale-repo',
                    label: 'Renamed Workspace',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            resolveSessionRenderable: (item: any) => sessionRenderablesById[item.sessionId] ?? null,
        });

        expect(summary.displayById.get('sess-renamed')).toEqual({
            machineId: 'machine-stale',
            machineLabel: 'stale.local',
            workspaceSubtitle: 'Renamed Workspace',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });

    it('uses stable display attribution instead of live RPC reachability for row summaries', () => {
        storage.setState({
            sessions: {
                'sess-replaced': createSessionFixture({
                    id: 'sess-replaced',
                    serverId: 'server-a',
                    active: false,
                    metadata: {
                        machineId: 'machine-old',
                        host: 'old.local',
                        path: '/home/user/repo',
                        homeDir: '/home/user',
                    },
                }),
            },
            machines: {
                'machine-old': createMachineFixture({
                    id: 'machine-old',
                    active: false,
                    activeAt: 1,
                    replacedByMachineId: 'machine-current',
                    replacedAt: 2,
                    metadata: { host: 'old.local', homeDir: '/home/user', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' },
                }),
                'machine-current': createMachineFixture({
                    id: 'machine-current',
                    active: false,
                    activeAt: 3,
                    metadata: { displayName: 'Current machine', host: 'current.local', homeDir: '/home/user', platform: 'linux', happyCliVersion: 'test', happyHomeDir: '/home/user/.happier' },
                }),
            },
        });
        storage.setState({ machineListByServerId: { 'server-a': Object.values(storage.getState().machines) } });

        const summary = buildSessionListReachabilitySummary({
            listItems: [
                {
                    type: 'session',
                    sessionId: 'sess-replaced',
                    serverId: 'server-a',
                },
            ] as any,
            machinesById: new Map([
                ['machine-old', { id: 'machine-old', metadata: { host: 'old.local' } }],
                ['machine-current', { id: 'machine-current', metadata: { displayName: 'Current machine', host: 'current.local' } }],
            ]),
            workspaceRefs: [],
            resolveSessionRenderable: () => ({
                metadata: {
                    machineId: 'machine-old',
                    host: 'old.local',
                    path: '/home/user/repo',
                    homeDir: '/home/user',
                },
            }) as any,
        });

        expect(summary.displayById.get('sess-replaced')).toEqual({
            machineId: 'machine-current',
            machineLabel: 'Current machine',
            workspaceSubtitle: 'repo',
            workspaceSubtitleEllipsizeMode: 'tail',
        });
    });
});
