import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

import {
    resolveMachineControlTargetForSessionFromState,
    resolveMachineControlTargetStateForSessionFromState,
    resolveMachineTargetForSessionFromState,
} from './resolveMachineTargetForSessionFromState';

function activeMachine(id: string, host: string) {
    return {
        id,
        active: true,
        activeAt: 1,
        metadata: { host },
    };
}

describe('resolveMachineTargetForSessionFromState', () => {
    it('uses the exact Home owner view when the compact row has no private machine target', () => {
        const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: true,
            metadataLayoutVersion: 1, metadata: { path: '', host: '' },
            ownerMetadataView: { machineId: 'owner-machine', path: '/owner/repo', host: 'owner.local' },
        });
        const machine = createMachineFixture({ id: 'owner-machine', active: true });
        const state = { sessions: { s1: session }, machines: {},
            machineListByServerId: { 'home-a': [machine] },
            sessionListRowsByServerId: { 'home-a': { s1: buildSessionListRenderableFromSession({
                ...session, ownerMetadataView: null,
            }) } },
        };
        const target = { serverId: 'home-a', sessionId: 's1' };
        expect(resolveMachineTargetForSessionFromState(state, target)).toEqual({
            machineId: 'owner-machine', basePath: '/owner/repo',
        });
        expect(resolveMachineControlTargetForSessionFromState(state, target)).toEqual({
            machineId: 'owner-machine', basePath: '/owner/repo', confidence: 'reachable',
        });
    });

    it('does not use a shared-only compact row as an exact Home private control target', () => {
        const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: true,
            metadataLayoutVersion: 1, accessLevel: 'view',
            metadata: { path: '/shared/repo', host: 'shared.local', machineId: 'shared-machine' },
            ownerMetadataView: null,
        });
        const row = { ...buildSessionListRenderableFromSession(session),
            metadata: { path: '/shared/repo', host: 'shared.local', machineId: 'shared-machine' } };
        const machine = createMachineFixture({ id: 'shared-machine', active: true });
        const state = { sessions: {}, machines: {}, machineListByServerId: { 'home-a': [machine] },
            sessionListRowsByServerId: { 'home-a': { s1: row } } };
        expect(resolveMachineControlTargetForSessionFromState(state, { serverId: 'home-a', sessionId: 's1' })).toBeNull();
    });

    it('distinguishes target hydration from a settled ambiguous Home target', () => {
        const target = { serverId: 'home-a', sessionId: 's1' };
        const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: false,
            metadata: { path: '/repo', host: 'shared.local' } });
        const machines = ['one', 'two'].map(id => createMachineFixture({ id, active: true,
            metadata: { ...createMachineFixture().metadata!, host: 'shared.local' } }));
        const state = { sessions: { s1: session }, machines: {}, machineListByServerId: { 'home-a': machines },
            machineListStatusByServerId: { 'home-a': 'idle' as const } };
        expect(resolveMachineControlTargetStateForSessionFromState({ ...state, sessions: {} }, target))
            .toEqual({ status: 'loading' });
        expect(resolveMachineControlTargetStateForSessionFromState({ ...state, machineListByServerId: {},
            machineListStatusByServerId: { 'home-a': 'loading' } }, target)).toEqual({ status: 'loading' });
        expect(resolveMachineControlTargetStateForSessionFromState(state, target)).toEqual({ status: 'unavailable' });
        expect(resolveMachineControlTargetStateForSessionFromState({ ...state, machineListByServerId: { 'home-a': [machines[0]!] } }, target))
            .toMatchObject({ status: 'ready', machineId: 'one', basePath: '/repo' });
    });
    it('reads the exact Home projection when duplicate Session ids exist', () => {
        const row = (machineId: string, path: string) => ({
            id: 'same-session',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: { machineId, path },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        });
        const state = {
            sessions: {
                'same-session': {
                    id: 'same-session',
                    serverId: 'home-a',
                    active: true,
                    updatedAt: 1,
                    metadata: { machineId: 'machine-a', path: '/repo/a' },
                },
            },
            sessionListRowsByServerId: {
                'home-a': { 'same-session': row('machine-a', '/repo/a') },
                'home-b': { 'same-session': row('machine-b', '/repo/b') },
            },
            machines: {
                'machine-a': activeMachine('machine-a', 'a.local'),
                'machine-b': activeMachine('machine-b', 'b.local'),
            },
            machineListByServerId: { 'home-b': [activeMachine('machine-b', 'b.local')] },
            getProjectForSession: () => ({ key: { machineId: 'machine-a', rootPath: '/repo/a' } }),
        } as any;

        expect(resolveMachineControlTargetForSessionFromState(state, {
            serverId: 'home-b',
            accountId: 'account-b',
            sessionId: 'same-session',
        })).toEqual({
            machineId: 'machine-b',
            basePath: '/repo/b',
            confidence: 'reachable',
        });
    });

    it('resolves a Home-qualified terminal target from that Home machine inventory', () => {
        const activeMachine = createMachineFixture({ id: 'same-machine', active: false });
        const foreignMachine = createMachineFixture({ id: 'same-machine', active: true });
        const foreignSession = createSessionFixture({
            id: 'same-session', serverId: 'home-b', active: true,
            metadata: { path: '/home-b/project', host: 'home-b', machineId: 'same-machine' },
        });
        const state = {
            sessions: { 'same-session': createSessionFixture({ id: 'same-session', serverId: 'home-a' }) },
            machines: { 'same-machine': activeMachine },
            machineListByServerId: { 'home-b': [foreignMachine] },
            sessionListRowsByServerId: { 'home-b': { 'same-session': buildSessionListRenderableFromSession(foreignSession) } },
        };
        expect(resolveMachineTargetForSessionFromState(state, { serverId: 'home-b', sessionId: 'same-session' }))
            .toEqual({ machineId: 'same-machine', basePath: '/home-b/project' });
    });

    it('does not use layout-v1 shared metadata as a private machine control fallback', () => {
        const state = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 1,
                    metadataLayoutVersion: 1,
                    metadata: {
                        machineId: 'shared-machine',
                        path: '/shared/private-path',
                    },
                    ownerMetadataView: null,
                },
            },
            machines: {
                'shared-machine': {
                    ...activeMachine('shared-machine', 'shared.local'),
                    metadata: { host: 'shared.local', homeDir: '/shared' },
                },
            },
            getProjectForSession: () => null,
        } as any;

        expect(resolveMachineTargetForSessionFromState(state, 's1')).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toBeNull();
    });

    it('uses the layout-v1 owner compatibility view for private machine controls', () => {
        const state = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 1,
                    metadataLayoutVersion: 1,
                    metadata: {
                        machineId: 'shared-machine',
                        path: '/shared/private-path',
                    },
                    ownerMetadataView: {
                        machineId: 'owner-machine',
                        path: '/owner/repo',
                        host: 'owner.local',
                        homeDir: '/owner',
                    },
                },
            },
            machines: {
                'owner-machine': {
                    ...activeMachine('owner-machine', 'owner.local'),
                    metadata: { host: 'owner.local', homeDir: '/owner' },
                },
            },
            getProjectForSession: () => null,
        } as any;

        expect(resolveMachineTargetForSessionFromState(state, 's1')).toEqual({
            machineId: 'owner-machine',
            basePath: '/owner/repo',
        });
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toEqual({
            machineId: 'owner-machine',
            basePath: '/owner/repo',
            confidence: 'reachable',
        });
    });

    it('falls back to the unique active host machine when project machine id is the unknown sentinel', () => {
        const state = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 1,
                    metadata: {
                        path: '/repo',
                        host: 'workstation.local',
                    },
                },
            },
            machines: {
                'machine-active': activeMachine('machine-active', 'workstation.local'),
            },
            getProjectForSession: () => ({
                key: {
                    machineId: 'unknown',
                    rootPath: '/repo',
                },
            }),
        } as any;

        expect(resolveMachineTargetForSessionFromState(state, 's1')).toEqual({
            machineId: 'machine-active',
            basePath: '/repo',
        });
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toEqual({
            machineId: 'machine-active',
            basePath: '/repo',
            confidence: 'reachable',
        });
    });

    it('does not return the unknown sentinel as a control target when host fallback is ambiguous', () => {
        const state = {
            sessions: {
                s1: {
                    active: false,
                    updatedAt: 1,
                    metadata: {
                        path: '/repo',
                        host: 'workstation.local',
                    },
                },
            },
            machines: {
                'machine-a': activeMachine('machine-a', 'workstation.local'),
                'machine-b': activeMachine('machine-b', 'workstation.local'),
            },
            getProjectForSession: () => ({
                key: {
                    machineId: 'unknown',
                    rootPath: '/repo',
                },
            }),
        } as any;

        expect(resolveMachineTargetForSessionFromState(state, 's1')).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toBeNull();
    });
});
