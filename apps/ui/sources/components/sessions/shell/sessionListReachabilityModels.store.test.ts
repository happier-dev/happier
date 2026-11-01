import { afterEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { SessionOrganizationLabel } from '@happier-dev/protocol';
import { buildSessionOrganizationLabelKey } from '@/sync/domains/session/organization/keys';
import { resolveSessionWorkspacePresentation } from '@/sync/domains/session/listing/sessionWorkspacePresentation';
import { getActiveServerSnapshot, removeServerProfile, setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { buildSessionListReachabilityModels, createSessionListReachabilityModelsCache } from './sessionListReachabilityModels';

const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

describe('session reachability display invalidation', () => {
    it('invalidates retained active overlays when the active server changes', () => {
        const previousServerId = getActiveServerSnapshot().serverId;
        const homeA = upsertServerProfile({ serverUrl: 'https://reachability-active-a.example.test' });
        const homeB = upsertServerProfile({ serverUrl: 'https://reachability-active-b.example.test' });
        try {
            setActiveServerId(homeA.id);
            const serverId = getActiveServerSnapshot().serverId;
            const session = createSessionFixture({ metadata: { machineId: 'machine-1', path: '/row-metadata', host: 'host' } });
            const activeSession = { ...session, metadata: { ...session.metadata!, path: '/active-target' } };
            const machine = createMachineFixture();
            storage.setState({ sessions: { [session.id]: activeSession }, machines: { [machine.id]: machine } });
            const items: SessionListViewItem[] = [{ type: 'session', serverId, session }];
            const input = { cache: createSessionListReachabilityModelsCache(), items, workspaceLabelsByLabelKey: {},
                machinesById: { [machine.id]: buildMachineDisplayRenderableFromMachine(machine) }, activeServerId: serverId };
            const first = buildSessionListReachabilityModels(input);
            expect(first.reachableSessionDisplayByKey.get(`${serverId}:session-1`)?.workspaceSubtitle).toBe('active-target');
            setActiveServerId(homeB.id);
            const second = buildSessionListReachabilityModels({ ...input, activeServerId: getActiveServerSnapshot().serverId });
            expect(second.reachableSessionDisplayByKey.get(`${serverId}:session-1`)?.workspaceSubtitle).toBe('row-metadata');
        } finally {
            setActiveServerId(previousServerId);
            removeServerProfile(homeA.id);
            removeServerProfile(homeB.id);
        }
    });
    it('selects each server workspace label and retains rows when other labels or colours change', () => {
        const session = createSessionFixture();
        const machine = createMachineFixture();
        const machinesById = { [machine.id]: buildMachineDisplayRenderableFromMachine(machine) };
        storage.setState({ sessions: {}, machines: { [machine.id]: machine } });
        const workspaceKey = resolveSessionWorkspacePresentation({ metadata: session.metadata, machines: machinesById }).workspaceKey;
        const label = (name: string): SessionOrganizationLabel => ({ labelKind: 'workspace', scopeKey: workspaceKey,
            display: { t: 'plain', v: { label: name } }, createdAt: 1, updatedAt: 1, archivedAt: null });
        const key = (serverId: string) => buildSessionOrganizationLabelKey({ serverId, labelKind: 'workspace', scopeKey: workspaceKey });
        const labels = { [key('server-a')]: label('Workspace A'), [key('server-b')]: label('Workspace B') };
        const items: SessionListViewItem[] = ['server-a', 'server-b', 'server-c'].map(serverId => ({ type: 'session', serverId, session }));
        const cache = createSessionListReachabilityModelsCache();
        const input = { cache, items, machinesById, workspaceLabelsByLabelKey: labels };
        const first = buildSessionListReachabilityModels(input);
        const rowA = first.reachableSessionDisplayByKey.get('server-a:session-1');
        const rowB = first.reachableSessionDisplayByKey.get('server-b:session-1');
        expect(rowA?.workspaceSubtitle).toBe('Workspace A');
        expect(rowB?.workspaceSubtitle).toBe('Workspace B');
        expect(first.reachableSessionDisplayByKey.get('server-c:session-1')?.workspaceSubtitle).toBe('project');
        const colourOnly = { ...labels, [key('server-a')]: { ...label('Workspace A'),
            display: { t: 'plain' as const, v: { label: 'Workspace A', color: { kind: 'accent', key: 'blue' } } } },
            [key('server-other')]: label('Unrelated') };
        expect(buildSessionListReachabilityModels({ ...input, workspaceLabelsByLabelKey: colourOnly })).toBe(first);
        const changed = buildSessionListReachabilityModels({ ...input, workspaceLabelsByLabelKey: { ...labels, [key('server-b')]: label('Renamed B') } });
        expect(changed.reachableSessionDisplayByKey.get('server-a:session-1')).toBe(rowA);
        expect(changed.reachableSessionDisplayByKey.get('server-b:session-1')).not.toBe(rowB);
        expect(changed.reachableSessionDisplayByKey.get('server-b:session-1')?.workspaceSubtitle).toBe('Renamed B');
        expect(buildSessionListReachabilityModels({ ...input, cache: createSessionListReachabilityModelsCache(),
            workspaceLabelsByLabelKey: { ...labels, [key('server-b')]: label('Renamed B') } })).toBe(changed);
    });
    it('retains the display projection on machine heartbeats but updates names, replacements and paths', () => {
        const session = createSessionFixture();
        const machine = createMachineFixture();
        machine.metadata = { ...machine.metadata!, displayName: 'Laptop' };
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
        const cache = createSessionListReachabilityModelsCache();
        const items: SessionListViewItem[] = [{ type: 'session', serverId: 'server-a', session }];
        const workspaceLabelsByLabelKey = {};
        const build = (machines: Machine[], rows = items) => buildSessionListReachabilityModels({
            cache, items: rows, workspaceLabelsByLabelKey,
            machinesById: Object.fromEntries(machines.map((value) => [value.id, buildMachineDisplayRenderableFromMachine(value)])),
        });
        const first = build([machine]);
        expect(first.reachableSessionDisplayByKey.get('server-a:session-1')).toMatchObject({
            machineId: 'machine-1', machineLabel: 'Laptop', workspaceSubtitle: 'project',
        });

        const heartbeat = { ...machine, activeAt: 2, updatedAt: 2 };
        storage.setState({ machines: { [heartbeat.id]: heartbeat } });
        // A refreshed source array must also reuse the existing per-row cache.
        expect(build([heartbeat], [...items])).toBe(first);

        const renamed = { ...heartbeat, metadata: { ...heartbeat.metadata!, displayName: 'Work laptop' } };
        storage.setState({ machines: { [renamed.id]: renamed } });
        expect(build([renamed]).reachableSessionDisplayByKey.get('server-a:session-1')?.machineLabel).toBe('Work laptop');

        const replacement = { ...renamed, id: 'machine-2', metadata: { ...renamed.metadata, displayName: 'Replacement' } };
        const predecessor = { ...renamed, replacedByMachineId: replacement.id };
        storage.setState({ machines: { [predecessor.id]: predecessor, [replacement.id]: replacement } });
        expect(build([predecessor, replacement]).reachableSessionDisplayByKey.get('server-a:session-1')).toMatchObject({
            machineId: 'machine-2', machineLabel: 'Replacement',
        });

        const moved = { ...session, metadata: { ...session.metadata!, path: '/Users/tester/moved' } };
        storage.setState({ sessions: { [moved.id]: moved } });
        expect(build([predecessor, replacement], [{ ...items[0], type: 'session', session: moved }])
            .reachableSessionDisplayByKey.get('server-a:session-1')?.workspaceSubtitle).toBe('moved');
    });
});
