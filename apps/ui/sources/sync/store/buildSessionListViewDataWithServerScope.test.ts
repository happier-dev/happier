import { describe, expect, it } from 'vitest';

import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { applyReachableTargetsToSessionListRenderables } from './buildSessionListViewDataWithServerScope';

function createSessionRecord(input: Readonly<{
    id: string;
    active: boolean;
    path: string;
    machineId: string;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: input.active,
        activeAt: input.active ? 30 : 0,
        metadata: {
            path: input.path,
            host: 'workstation.local',
            machineId: input.machineId,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: input.active ? 'online' : 20,
    };
}

function createRenderableSession(input: Readonly<{
    id: string;
    active: boolean;
    path: string;
    machineId: string;
}>): SessionListRenderableSession {
    return {
        id: input.id,
        seq: 1,
        createdAt: 10,
        updatedAt: 20,
        active: input.active,
        activeAt: input.active ? 30 : 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            path: input.path,
            host: 'workstation.local',
            machineId: input.machineId,
        },
        thinking: false,
        thinkingAt: 0,
        presence: input.active ? 'online' : 20,
    };
}

function createMachineRecord(machineId: string): Machine {
    return {
        id: machineId,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 3,
        metadata: {
            host: 'workstation.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/tester/.happy',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('applyReachableTargetsToSessionListRenderables', () => {
    it('keeps an active worktree session renderable on the session path instead of the linked project path', () => {
        const sessionId = 'session-1';
        const machineId = 'machine-1';
        const worktreePath = '/Users/tester/repo/.dev/worktree/gentle-meadow';
        const projectPath = '/Users/tester/repo';

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: {
                [sessionId]: createRenderableSession({
                    id: sessionId,
                    active: true,
                    path: worktreePath,
                    machineId,
                }),
            },
            sessionRecords: {
                [sessionId]: createSessionRecord({
                    id: sessionId,
                    active: true,
                    path: worktreePath,
                    machineId,
                }),
            },
            machines: {},
            machineRecords: {
                [machineId]: createMachineRecord(machineId),
            },
            getProjectForSession: (candidateSessionId) => candidateSessionId === sessionId
                ? {
                    key: {
                        machineId,
                        path: projectPath,
                    },
                }
                : null,
        });

        expect(result[sessionId]?.metadata?.path).toBe(worktreePath);
    });

    it('projects linked direct-session machine targets into session list renderables', () => {
        const sessionId = 'session-direct';
        const result = applyReachableTargetsToSessionListRenderables({
            sessions: {
                [sessionId]: {
                    ...createRenderableSession({
                        id: sessionId,
                        active: false,
                        path: '/Users/tester/direct-repo',
                        machineId: '',
                    }),
                    metadata: {
                        path: '/Users/tester/direct-repo',
                        machineId: null,
                        directSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'machine-direct',
                            remoteSessionId: 'remote-1',
                        },
                    },
                } as any,
            },
            sessionRecords: {
                [sessionId]: {
                    ...createSessionRecord({
                        id: sessionId,
                        active: false,
                        path: '/Users/tester/direct-repo',
                        machineId: '',
                    }),
                    metadata: {
                        path: '/Users/tester/direct-repo',
                        machineId: null,
                        directSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'machine-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                } as any,
            },
            machines: {},
            machineRecords: {
                'machine-direct': createMachineRecord('machine-direct'),
                'machine-other': createMachineRecord('machine-other'),
            },
            getProjectForSession: () => null,
        });

        expect(result[sessionId]?.metadata?.machineId).toBe('machine-direct');
        expect(result[sessionId]?.metadata?.path).toBe('/Users/tester/direct-repo');
    });
});
