import { describe, expect, it, vi } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { SessionAddress } from './sessionAddress';
import { resolveWorkspaceTargetForSessionFromState } from './resolveWorkspaceTargetForSessionFromState';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-active', serverUrl: 'https://example.com', generation: 1 }),
}));

function activeMachine(id: string, host: string) {
    return { id, active: true, activeAt: 1, metadata: { host } };
}

describe('resolveWorkspaceTargetForSessionFromState', () => {
    it('resolves the exact Home row when two Homes contain the same Session id', () => {
        const row = (machineId: string, path: string) => ({
            id: 'same-session',
            seq: 1,
            createdAt: 1,
            updatedAt: 10,
            active: true,
            activeAt: 10,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: { machineId, path },
            thinking: false,
            thinkingAt: 0,
            presence: 'online' as const,
        });
        const result = resolveWorkspaceTargetForSessionFromState({
            // The active/global compatibility record belongs to Home A. Exact
            // Search targeting must not let it win over Home B's projection.
            sessions: {
                'same-session': {
                    id: 'same-session',
                    serverId: 'home-a',
                    active: true,
                    updatedAt: 10,
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
            machineListByServerId: {
                'home-a': [activeMachine('machine-a', 'a.local')],
                'home-b': [activeMachine('machine-b', 'b.local')],
            },
            getProjectForSession: () => ({ key: { machineId: 'machine-a', rootPath: '/repo/a' } }),
        } as any, {
            serverId: 'home-b',
            accountId: 'account-b',
            sessionId: 'same-session',
        });

        expect(result).toEqual(expect.objectContaining({
            serverId: 'home-b',
            machineId: 'machine-b',
            rootPath: '/repo/b',
        }));
    });

    it('resolves linked direct-session targets from canonical metadata when list metadata is stripped', () => {
        const result = resolveWorkspaceTargetForSessionFromState({
            sessions: {
                s1: {
                    id: 's1',
                    active: false,
                    updatedAt: 10,
                    metadata: {
                        path: '/workspace/direct-repo',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                            machineId: 'm-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                            linkedAtMs: 1,
                            qualifiedIdentity: {
                                v: 1,
                                agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                                source: { kind: 'codexHome', contractVersion: 1 },
                            },
                        },
                    },
                },
            },
            sessionListRowsByServerId: {
                'server-a': {
                    s1: {
                        id: 's1',
                        seq: 1,
                        createdAt: 1,
                        updatedAt: 10,
                        active: false,
                        activeAt: 0,
                        metadataVersion: 1,
                        agentStateVersion: 1,
                        metadata: {
                            path: '/workspace/direct-repo',
                            machineId: null,
                            externalSessionV1: {
                                v: 1,
                                agentId: 'codex',
                            },
                        },
                        thinking: false,
                        thinkingAt: 0,
                        presence: 0,
                    },
                },
            },
            ordinarySessionListMembershipByServerId: { 'server-a': ['s1'] },
            sessionListIndexByServerId: {
                'server-a': [
                    {
                        type: 'session',
                        sessionId: 's1',
                        serverId: 'server-a',
                        serverName: 'Server A',
                    },
                ],
            },
            machines: {
                'm-other': {
                    id: 'm-other',
                    active: true,
                    activeAt: 20,
                    metadata: { host: 'other.local' },
                },
                'm-direct': {
                    id: 'm-direct',
                    // Workspace target resolution is the reachable-target
                    // owner; this case is about reading the canonical direct
                    // Session metadata rather than offline fallback behavior.
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        } as any, 's1');

        expect(result).toEqual(expect.objectContaining({
            serverId: 'server-a',
            machineId: 'm-direct',
            rootPath: '/workspace/direct-repo',
        }));
    });

    it('rejects a fallback Home when the Session has no known origin', () => {
        const result = resolveWorkspaceTargetForSessionFromState({
            sessions: {
                s1: {
                    id: 's1',
                    active: false,
                    updatedAt: 10,
                    metadata: {
                        path: '/workspace/direct-repo',
                        externalSessionV1: {
                            v: 1,
                            agentId: 'codex',
                            machineId: 'm-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                            linkedAtMs: 1,
                            qualifiedIdentity: {
                                v: 1,
                                agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                                source: { kind: 'codexHome', contractVersion: 1 },
                            },
                        },
                    },
                },
            },
            machines: {
                'm-direct': {
                    id: 'm-direct',
                    active: true,
                    activeAt: 1,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        } as any, 's1', { fallbackServerId: 'server-scoped' });

        expect(result).toBeNull();
    });

    it('resolves an explicit Home address from its scoped machine inventory', () => {
        const address = { serverId: 'server-scoped', sessionId: 's1' } satisfies SessionAddress;
        const machine = createMachineFixture({ id: 'm-direct' });
        const result = resolveWorkspaceTargetForSessionFromState({
            sessions: {
                s1: {
                    id: 's1',
                    serverId: address.serverId,
                    active: false,
                    updatedAt: 10,
                    metadata: { machineId: machine.id, path: '/workspace/direct-repo' },
                },
            },
            machineListByServerId: { [address.serverId]: [machine] },
            getProjectForSession: () => null,
        }, address);

        expect(result).toEqual(expect.objectContaining({
            serverId: 'server-scoped',
            machineId: 'm-direct',
            rootPath: '/workspace/direct-repo',
        }));
    });
});
