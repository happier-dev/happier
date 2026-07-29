import { describe, expect, it, vi } from 'vitest';

import { resolveWorkspaceTargetForSessionFromState } from './resolveWorkspaceTargetForSessionFromState';

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-active', serverUrl: 'https://example.com', generation: 1 }),
}));

describe('resolveWorkspaceTargetForSessionFromState', () => {
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
                        },
                    },
                },
            },
            sessionListRenderables: {
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
                    active: false,
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

    it('prefers an explicit fallback server id when canonical index scope is unavailable', () => {
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
                        },
                    },
                },
            },
            sessionListRenderables: {
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
            machines: {
                'm-direct': {
                    id: 'm-direct',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'direct.local' },
                },
            },
            getProjectForSession: () => null,
        } as any, 's1', { fallbackServerId: 'server-scoped' });

        expect(result).toEqual(expect.objectContaining({
            serverId: 'server-scoped',
            machineId: 'm-direct',
            rootPath: '/workspace/direct-repo',
        }));
    });
});
