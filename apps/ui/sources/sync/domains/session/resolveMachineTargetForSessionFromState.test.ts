import { describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { linkMachineActivity, publishMachineActivity } from '@/sync/domains/machines/machineActivity';

import {
    resolveMachineControlTargetForSessionFromState,
    resolveMachineControlTargetStateForSessionFromState,
    resolveDisplayMachineTargetForSessionFromState,
    resolveMachineTerminalTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
} from './resolveMachineTargetForSessionFromState';

function answeredMachineFixture(overrides: Parameters<typeof createMachineFixture>[0] = {}) {
    const machine = createMachineFixture({ presenceProtocolVersion: 1, ...overrides });
    publishMachineActivity(machine, { active: machine.active, activeAt: machine.activeAt }, []);
    return machine;
}

function activeMachine(id: string, host: string) {
    return answeredMachineFixture({ id, activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, host } });
}

describe('resolveMachineTargetForSessionFromState', () => {
    it('retains a cold Machine RPC target until presence answers, without treating it as online', () => {
        const machine = createMachineFixture({ id: 'cold-machine', active: false, presenceProtocolVersion: 1 });
        linkMachineActivity(machine, { ...machine });
        const session = createSessionFixture({ id: 'cold-session', active: true,
            metadata: { machineId: machine.id, path: '/workspace', host: 'cold.local' } });
        const state = { sessions: { [session.id]: session }, machines: { [machine.id]: machine } };
        const target = { machineId: machine.id, basePath: '/workspace' };
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toEqual(target);
        expect(resolveMachineControlTargetForSessionFromState(state, session.id)).toMatchObject(target);
        publishMachineActivity(machine, { active: false, activeAt: machine.activeAt }, []);
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, session.id)).toBeNull();
        publishMachineActivity(machine, { active: true, activeAt: machine.activeAt + 1 }, []);
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toEqual(target);
    });

    it('uses the presence owner for an answered legacy Machine whose heartbeat has expired', () => {
        const machine = createMachineFixture({ id: 'expired-machine', active: true, activeAt: 1 });
        const session = createSessionFixture({ id: 'expired-session', active: true,
            metadata: { machineId: machine.id, path: '/workspace', host: 'expired.local' } });
        const state = { sessions: { [session.id]: session }, machines: { [machine.id]: machine } };
        publishMachineActivity(machine, { active: true, activeAt: 1 }, []);
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, session.id)).toBeNull();
    });

    it('retains the canonical workspace Machine target for an offline Session', () => {
        const session = createSessionFixture({ id: 'offline-bound-session', active: true, metadata: {
            path: '', host: '',
            sessionWorkspaceLocationV1: {
                v: 1,
                machineId: 'machine-nldw',
                agentPath: '/agent/project',
                machinePath: '/machine/project',
            },
        } as any, serverId: 'home-a' });
        const machine = answeredMachineFixture({ id: 'machine-nldw', active: false });
        const state = { sessions: { [session.id]: session }, machines: { [machine.id]: machine },
            sessionListRowsByServerId: { 'home-a': { [session.id]: buildSessionListRenderableFromSession(session) } } };

        expect(resolveMachineTargetForSessionFromState(state, session.id)).toBeNull();
        expect(resolveDisplayMachineTargetForSessionFromState({ state, sessionId: session.id }))
            .toEqual({ machineId: 'machine-nldw', basePath: '/agent/project' });
        expect(resolveMachineTerminalTargetForSessionFromState({ state, sessionId: session.id }))
            .toEqual({ machineId: 'machine-nldw', basePath: '/machine/project', agentBasePath: '/agent/project' });
    });

    it.each(['retained', 'missing'] as const)('keeps an explicit guest identity while it boots (%s)', (origin) => {
        const metadata = { ...answeredMachineFixture().metadata!, host: 'lume.local', homeDir: '/Users/lume' };
        const guest = answeredMachineFixture({ id: 'guest', active: false, metadata });
        const clone = answeredMachineFixture({ id: 'older-guest', active: true, metadata });
        const session = createSessionFixture({ id: 'wake-session', active: false,
            metadata: { machineId: guest.id, path: '/Users/lume/project', host: metadata.host, homeDir: metadata.homeDir } });
        const state = { sessions: { [session.id]: session }, machines: {
            ...(origin === 'retained' ? { [guest.id]: guest } : {}), [clone.id]: clone,
        } };
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, session.id)).toEqual(origin === 'retained' ? null : {
            machineId: guest.id, basePath: '/Users/lume/project', confidence: 'metadata_direct',
        });
        const ready = { ...state, machines: { ...state.machines, [guest.id]: answeredMachineFixture({ ...guest, active: true }) } };
        expect(resolveMachineTargetForSessionFromState(ready, session.id)).toEqual({
            machineId: guest.id, basePath: '/Users/lume/project',
        });
    });

    it('reads current Machine activity when the retained inventory object is unchanged', () => {
        const machine = answeredMachineFixture({ id: 'presence-machine', active: true });
        const session = createSessionFixture({ id: 'presence-session', active: true,
            metadata: { machineId: machine.id, path: '/workspace', host: 'presence.local' } });
        const state = { sessions: { [session.id]: session }, machines: { [machine.id]: machine } };
        const target = { machineId: machine.id, basePath: '/workspace' };
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toEqual(target);
        publishMachineActivity(machine, { active: false, activeAt: machine.activeAt }, []);
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, session.id)).toBeNull();
        publishMachineActivity(machine, { active: true, activeAt: machine.activeAt + 1 }, []);
        expect(resolveMachineTargetForSessionFromState(state, session.id)).toEqual(target);
    });

    it('uses the exact Home owner view when the compact row has no private machine target', () => {
        const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: true,
            metadataLayoutVersion: 1, metadata: { path: '', host: '' },
            ownerMetadataView: { machineId: 'owner-machine', path: '/owner/repo', host: 'owner.local' },
        });
        const machine = answeredMachineFixture({ id: 'owner-machine', active: true });
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
        const machine = answeredMachineFixture({ id: 'shared-machine', active: true });
        const state = { sessions: {}, machines: {}, machineListByServerId: { 'home-a': [machine] },
            sessionListRowsByServerId: { 'home-a': { s1: row } } };
        expect(resolveMachineControlTargetForSessionFromState(state, { serverId: 'home-a', sessionId: 's1' })).toBeNull();
    });

    it.each(['legacy', 'owner'] as const)('recovers an empty external Session path from its same-machine mapping (%s)', (layout) => {
        const metadata = {
            machineId: 'machine-1', path: '', host: 'host.local',
            sessionWorkspaceLocationV1: { v: 1 as const, machineId: 'machine-1',
                agentPath: '/agent/project', machinePath: '/host/project' },
        };
        const session = createSessionFixture({ id: 's1', active: true,
            ...(layout === 'owner'
                ? { metadataLayoutVersion: 1, metadata: { path: '', host: 'host.local' }, ownerMetadataView: metadata }
                : { metadata }),
        });
        const state = { sessions: { s1: session }, machines: {} };
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toEqual({
            machineId: 'machine-1', basePath: '/host/project', agentBasePath: '/agent/project',
            confidence: 'metadata_direct',
        });
        const foreign = { ...metadata, machineId: 'other-machine' };
        expect(resolveMachineControlTargetForSessionFromState({ ...state, sessions: {
            s1: { ...session, ...(layout === 'owner' ? { ownerMetadataView: foreign } : { metadata: foreign }) },
        } }, 's1')).toBeNull();
    });

    it.each(['replacement', 'same-host locality', 'same-host missing source'] as const)('does not recover an empty root on a foreign target (%s)', (route) => {
        const session = createSessionFixture({ id: 's1', active: false, metadata: {
            path: '', host: 'old.local', homeDir: '/home/user', machineId: 'machine-old',
            sessionWorkspaceLocationV1: { v: 1, machineId: 'machine-old',
                agentPath: '/agent/old-project', machinePath: '/host/old-project' },
        } });
        const machineMetadata = { ...answeredMachineFixture().metadata!, host: 'old.local', homeDir: '/home/user' };
        const state = { sessions: { s1: session }, machines: {
            ...(route === 'same-host missing source' ? {} : {
                'machine-old': answeredMachineFixture({ id: 'machine-old', active: false,
                    ...(route === 'replacement' ? { replacedByMachineId: 'machine-new' } : {}) }),
            }),
            'machine-new': answeredMachineFixture({ id: 'machine-new', active: true,
                ...(route !== 'replacement' ? { metadata: machineMetadata } : {}) }),
        } };
        expect(resolveMachineTargetForSessionFromState(state, 's1')).toBeNull();
        expect(resolveMachineControlTargetForSessionFromState(state, 's1')).toEqual(route === 'same-host missing source' ? {
            machineId: 'machine-old', basePath: '/host/old-project', agentBasePath: '/agent/old-project',
            confidence: 'metadata_direct',
        } : null);

        const withProject = { ...state, getProjectForSession: () => ({
            key: { machineId: 'machine-new', rootPath: '/new/project' },
        }) };
        expect(resolveMachineTargetForSessionFromState(withProject, 's1')).toEqual(route === 'replacement' ? {
            machineId: 'machine-new', basePath: '/new/project',
        } : null);
        expect(resolveMachineControlTargetForSessionFromState(withProject, 's1')).toEqual(route === 'replacement' ? {
            machineId: 'machine-new', basePath: '/new/project', confidence: 'reachable',
        } : null);
    });

    it('distinguishes target hydration from a settled ambiguous Home target', () => {
        const target = { serverId: 'home-a', sessionId: 's1' };
        const session = createSessionFixture({ id: 's1', serverId: 'home-a', active: false,
            metadata: { path: '/repo', host: 'shared.local' } });
        const machines = ['one', 'two'].map(id => answeredMachineFixture({ id, active: true,
            metadata: { ...answeredMachineFixture().metadata!, host: 'shared.local' } }));
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
        const activeMachine = answeredMachineFixture({ id: 'same-machine', active: false });
        const foreignMachine = answeredMachineFixture({ id: 'same-machine', active: true });
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
