import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildMachineDisplayRenderableFromMachine } from '@/sync/domains/machines/machineDisplayRenderable';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

import {
    buildSessionListReachabilitySummary,
    createSessionListReachabilitySummaryCache,
    retireSessionListReachabilitySummaryCacheServerScope,
} from './buildSessionListReachabilitySummary';

const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

function machineDisplayMap(machines: readonly Machine[]) {
    return new Map(machines.map((machine) => [machine.id, buildMachineDisplayRenderableFromMachine(machine)]));
}

describe('session reachability summary with real storage', () => {
    it('retains display identity across heartbeats while names and replacement targets stay current', () => {
        const session = createSessionFixture({ serverId: 'server-a' });
        const machine = createMachineFixture();
        machine.metadata = { ...machine.metadata!, displayName: 'Laptop' };
        storage.setState({ sessions: { [session.id]: session } });
        const cache = createSessionListReachabilitySummaryCache();
        const listItems: SessionListIndexItem[] = [{ type: 'session', serverId: 'server-a', sessionId: session.id }];
        const workspaceRefs: WorkspaceRefV1[] = [];
        const renderable: SessionListReachabilityRenderable = { id: session.id, metadata: session.metadata };
        const build = (machines: readonly Machine[]) => {
            storage.setState({
                machines: Object.fromEntries(machines.map((value) => [value.id, value])),
                machineListByServerId: { 'server-a': [...machines] },
            });
            return buildSessionListReachabilitySummary({
                cache, listItems: [...listItems], workspaceRefs,
                machinesById: machineDisplayMap(machines),
                resolveSessionRenderable: () => renderable,
            });
        };
        const key = sessionAddressKey({ serverId: 'server-a', sessionId: session.id });
        const first = build([machine]);
        expect(first.displayByKey.get(key)).toMatchObject({
            machineId: machine.id, machineLabel: 'Laptop', workspaceSubtitle: 'project',
        });

        const heartbeat = { ...machine, active: false, activeAt: 2, updatedAt: 2 };
        expect(build([heartbeat])).toBe(first);
        expect(storage.getState().machines[machine.id]?.active).toBe(false);

        const renamed = { ...heartbeat, metadata: { ...heartbeat.metadata!, displayName: 'Work laptop' } };
        expect(build([renamed]).displayByKey.get(key)?.machineLabel).toBe('Work laptop');
        const hostOnly = { ...renamed, metadata: { ...renamed.metadata, displayName: '', host: 'new.local' } };
        expect(build([hostOnly]).displayByKey.get(key)?.machineLabel).toBe('new.local');

        const replacement = { ...renamed, id: 'machine-2', metadata: { ...renamed.metadata, displayName: 'Replacement' } };
        const predecessor = { ...renamed, replacedByMachineId: replacement.id };
        const replaced = build([predecessor, replacement]);
        expect(replaced.displayByKey.get(key)).toMatchObject({ machineId: replacement.id, machineLabel: 'Replacement' });
        expect(build([replacement, predecessor])).toBe(replaced);
        expect(build([predecessor]).displayByKey.get(key)).toMatchObject({ machineId: machine.id, machineLabel: 'Work laptop' });
        expect(build([predecessor, replacement]).displayByKey.get(key)?.machineId).toBe(replacement.id);
        expect(build([renamed, replacement]).displayByKey.get(key)?.machineId).toBe(machine.id);
    });

    it('keeps session paths, workspace references and path display settings fresh', () => {
        const session = createSessionFixture({ serverId: 'server-a' });
        const machine = createMachineFixture();
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
        const cache = createSessionListReachabilitySummaryCache();
        const listItems: SessionListIndexItem[] = [{ type: 'session', serverId: 'server-a', sessionId: session.id }];
        const machinesById = machineDisplayMap([machine]);
        const workspaceRefs: WorkspaceRefV1[] = [];
        const renderable: SessionListReachabilityRenderable = { id: session.id, metadata: session.metadata };
        const input = { cache, listItems, machinesById, workspaceRefs, resolveSessionRenderable: () => renderable };
        expect(buildSessionListReachabilitySummary(input).displayById.get(session.id)?.workspaceSubtitle).toBe('project');
        expect(buildSessionListReachabilitySummary({ ...input, workspacePathDisplayModeV1: 'path' })
            .displayById.get(session.id)?.workspaceSubtitle).toBe('~/project');

        const renamedRefs: WorkspaceRefV1[] = [{
            id: 'workspace-1', serverId: 'server-a', machineId: machine.id, rootPath: '/Users/tester/project',
            label: 'Renamed workspace', createdAtMs: 1, lastOpenedAtMs: null,
        }];
        expect(buildSessionListReachabilitySummary({ ...input, workspaceRefs: renamedRefs })
            .displayById.get(session.id)?.workspaceSubtitle).toBe('Renamed workspace');

        const moved = { ...session, metadata: { ...session.metadata!, path: '/Users/tester/moved' } };
        storage.setState({ sessions: { [moved.id]: moved } });
        expect(buildSessionListReachabilitySummary({
            ...input, resolveSessionRenderable: () => ({ id: moved.id, metadata: moved.metadata }),
        }).displayById.get(session.id)?.workspaceSubtitle).toBe('moved');
    });

    it('retires only the requested server scope and drops rows removed from the list', () => {
        const session = createSessionFixture({ serverId: 'server-a' });
        const machine = createMachineFixture();
        storage.setState({ sessions: { [session.id]: session }, machines: { [machine.id]: machine } });
        const cache = createSessionListReachabilitySummaryCache();
        const listItems: SessionListIndexItem[] = ['server-a', 'server-b'].map((serverId) => ({
            type: 'session', serverId, sessionId: session.id,
        }));
        const renderable: SessionListReachabilityRenderable = { id: session.id, metadata: session.metadata };
        const input = {
            cache, listItems, machinesById: machineDisplayMap([machine]), workspaceRefs: [],
            resolveSessionRenderable: () => renderable,
        };
        const first = buildSessionListReachabilitySummary(input);
        const keyA = sessionAddressKey({ serverId: 'server-a', sessionId: session.id });
        const keyB = sessionAddressKey({ serverId: 'server-b', sessionId: session.id });
        expect(first.displayByKey.size).toBe(2);
        retireSessionListReachabilitySummaryCacheServerScope(cache, 'server-a');
        const next = buildSessionListReachabilitySummary({ ...input, machinesById: machineDisplayMap([machine]) });
        expect(next.displayByKey.get(keyA)).toEqual(first.displayByKey.get(keyA));
        expect(next.displayByKey.get(keyA)).not.toBe(first.displayByKey.get(keyA));
        expect(next.displayByKey.get(keyB)).toBe(first.displayByKey.get(keyB));

        const empty = buildSessionListReachabilitySummary({ ...input, listItems: [] });
        expect(empty.displayByKey.size).toBe(0);
        const restored = buildSessionListReachabilitySummary(input);
        expect(restored.displayByKey.get(keyB)).toEqual(next.displayByKey.get(keyB));
        expect(restored.displayByKey.get(keyB)).not.toBe(next.displayByKey.get(keyB));
    });
});
