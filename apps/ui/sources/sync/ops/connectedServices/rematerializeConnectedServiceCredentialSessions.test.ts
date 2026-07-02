import { beforeEach, describe, expect, it, vi } from 'vitest';

import { profileDefaults } from '@/sync/domains/profiles/profile';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

function session(overrides: Partial<Session>): Session {
    return {
        id: 'session-1',
        serverId: 'server-1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            flavor: 'claude',
            machineId: 'machine-1',
            host: 'host',
            path: '/repo',
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('rematerializeActiveSessionsForConnectedServiceProfile', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({
            ok: true,
            action: 'restart_requested',
            normalizedBindings: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'work',
                    },
                },
            },
            continuityByServiceId: { anthropic: 'restart_rematerialize' },
            warnings: [],
        });
        storage.setState((state) => ({
            ...state,
            profile: {
                ...profileDefaults,
                connectedServicesV2: [{
                    serviceId: 'anthropic',
                    profiles: [{
                        profileId: 'work',
                        status: 'connected',
                        kind: 'oauth',
                        providerEmail: 'work@example.com',
                        providerAccountId: null,
                        expiresAt: null,
                        lastUsedAt: null,
                        health: null,
                    }],
                    groups: [{
                        groupId: 'team',
                        displayName: 'Team',
                        activeProfileId: 'work',
                        generation: 7,
                        memberProfileIds: ['work'],
                    }],
                }],
            },
            sessions: {},
            machines: {
                'machine-1': {
                    id: 'machine-1',
                    seq: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    active: true,
                    activeAt: 1,
                    metadata: {
                        host: 'host',
                        platform: 'darwin',
                        happyCliVersion: '1.0.0',
                        happyHomeDir: '/Users/test/.happy',
                        homeDir: '/Users/test',
                    },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 1,
                },
            },
        }));
    });

    it('restarts active sessions directly bound to the reconnected profile', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {
                direct: session({ id: 'direct' }),
                unrelated: session({
                    id: 'unrelated',
                    metadata: {
                        flavor: 'claude',
                        machineId: 'machine-1',
                        host: 'host',
                        path: '/repo',
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                anthropic: {
                                    source: 'connected',
                                    selection: 'profile',
                                    profileId: 'other',
                                },
                            },
                        },
                    },
                }),
                inactive: session({ id: 'inactive', active: false }),
            },
        }));

        const { rematerializeActiveSessionsForConnectedServiceProfile } = await import(
            './rematerializeConnectedServiceCredentialSessions'
        );

        const result = await rematerializeActiveSessionsForConnectedServiceProfile({
            serviceId: 'anthropic',
            profileId: 'work',
        });

        expect(result.requestedSessionIds).toEqual(['direct']);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledTimes(1);
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-1',
            payload: expect.objectContaining({
                sessionId: 'direct',
                agentId: 'claude',
                rematerializeServiceId: 'anthropic',
                bindings: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: {
                            source: 'connected',
                            selection: 'profile',
                            profileId: 'work',
                        },
                    },
                },
            }),
        }));
    });

    it('restarts active sessions bound to a group whose active profile was reconnected', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {
                grouped: session({
                    id: 'grouped',
                    metadata: {
                        flavor: 'claude',
                        machineId: 'machine-1',
                        host: 'host',
                        path: '/repo',
                        connectedServices: {
                            v: 1,
                            bindingsByServiceId: {
                                anthropic: {
                                    source: 'connected',
                                    selection: 'group',
                                    groupId: 'team',
                                    profileId: 'work',
                                },
                            },
                        },
                    },
                }),
            },
        }));

        const { rematerializeActiveSessionsForConnectedServiceProfile } = await import(
            './rematerializeConnectedServiceCredentialSessions'
        );

        await rematerializeActiveSessionsForConnectedServiceProfile({
            serviceId: 'anthropic',
            profileId: 'work',
        });

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                sessionId: 'grouped',
                rematerializeServiceId: 'anthropic',
                expectedGroupGenerationByServiceId: { anthropic: 7 },
            }),
        }));
    });
});
