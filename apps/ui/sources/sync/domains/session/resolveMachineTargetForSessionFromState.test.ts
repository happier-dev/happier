import { describe, expect, it } from 'vitest';

import {
    resolveMachineControlTargetForSessionFromState,
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
