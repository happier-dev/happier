import { describe, expect, it, vi } from 'vitest';
import { getServerUrl, setServerUrl } from '../../domains/server/serverConfig';
import { applyReachableTargetsToSessionListRenderables } from '../../domains/session/listing/applyReachableTargetsToSessionListRenderables';

import {
    buildActiveServerSessionListIndex,
    buildSessionListIndexWithServerScope,
} from './buildSessionListIndexWithServerScope';

describe('applyReachableTargetsToSessionListRenderables', () => {
    it('does not project layout-v1 owner workspace facts into participant shared list metadata', () => {
        const sessions = {
            s1: {
                id: 's1',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                accessLevel: 'view' as const,
                metadataLayoutVersion: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    v: 1,
                    summary: { text: 'Shared title', updatedAt: 1 },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            s1: {
                ...sessions.s1,
                ownerMetadataView: {
                    machineId: 'owner-machine',
                    path: '/owner/private/repo',
                    homeDir: '/owner',
                    host: 'owner.local',
                },
            },
        };
        const machineRecords = {
            'owner-machine': {
                id: 'owner-machine',
                active: true,
                activeAt: 1,
                metadata: {
                    host: 'owner.local',
                    homeDir: '/owner',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession: () => null,
        });

        expect(result).toBe(sessions);
        expect(result.s1.metadata).toEqual({
            v: 1,
            summary: { text: 'Shared title', updatedAt: 1 },
        });
    });

    it('returns early without project lookups when there are no visible sessions to project', () => {
        const getProjectForSession = vi.fn(() => ({
            key: {
                machineId: 'm1',
                rootPath: '/repo',
            },
        }));

        const sessions = {};
        const sessionRecords = {
            s1: {
                id: 's1',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                },
            },
        };
        const machineRecords = {
            m1: {
                id: 'm1',
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession).not.toHaveBeenCalled();
    });

    it('returns early without project lookups when no visible session has a backing session record', () => {
        const getProjectForSession = vi.fn(() => ({
            key: {
                machineId: 'm1',
                rootPath: '/repo',
            },
        }));

        const sessions = {
            visible: {
                id: 'visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            unrelated: {
                id: 'unrelated',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                },
            },
        };
        const machineRecords = {
            m1: {
                id: 'm1',
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession).not.toHaveBeenCalled();
    });

    it('returns early without project lookups when no visible session metadata can be rewritten', () => {
        const getProjectForSession = vi.fn(() => ({
            key: {
                machineId: 'm1',
                rootPath: '/repo',
            },
        }));

        const sessions = {
            visible: {
                id: 'visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: null,
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            visible: {
                id: 'visible',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                },
            },
            unrelated: {
                id: 'unrelated',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                },
            },
        };
        const machineRecords = {
            m1: {
                id: 'm1',
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession).not.toHaveBeenCalled();
    });

    it('avoids unrelated peer-session project lookups when visible rows resolve directly', () => {
        const getProjectForSession = vi.fn((sessionId: string) => ({
            key: {
                machineId: 'm1',
                rootPath: sessionId === 'visible' ? '/repo' : '/other',
            },
        }));

        const sessions = {
            visible: {
                id: 'visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            visible: {
                id: 'visible',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
            unrelated: {
                id: 'unrelated',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/other',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
        };
        const machineRecords = {
            m1: {
                id: 'm1',
                active: true,
                activeAt: 1,
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession.mock.calls).toEqual([['visible']]);
    });

    it('does not rewrite stale rows through peer fallback rows', () => {
        const getProjectForSession = vi.fn((sessionId: string) => ({
            key: {
                machineId: sessionId === 'stale' ? null : 'm-a',
                rootPath: '/repo',
            },
        }));

        const sessions = {
            direct: {
                id: 'direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm-a',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
            stale: {
                id: 'stale',
                seq: 2,
                createdAt: 2,
                updatedAt: 2,
                active: true,
                activeAt: 2,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm-stale',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-stale',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            direct: {
                id: 'direct',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm-a',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
            stale: {
                id: 'stale',
                active: true,
                updatedAt: 2,
                metadata: {
                    machineId: 'm-stale',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-stale',
                },
            },
            peer: {
                id: 'peer',
                active: true,
                updatedAt: 3,
                metadata: {
                    machineId: 'm-a',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
        };
        const machineRecords = {
            'm-a': {
                id: 'm-a',
                active: true,
                activeAt: 10,
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
            'm-b': {
                id: 'm-b',
                active: true,
                activeAt: 20,
                metadata: {
                    host: 'host-b',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession.mock.calls).toEqual([['direct'], ['stale']]);
    });

    it('leaves stale unresolved rows unchanged without peer project lookups', () => {
        const getProjectForSession = vi.fn((sessionId: string) => ({
            key: {
                machineId: sessionId === 'stale' ? null : 'm-a',
                rootPath: sessionId === 'unrelated' ? '/other' : '/repo',
            },
        }));

        const sessions = {
            stale: {
                id: 'stale',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm-stale',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-stale',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        };
        const sessionRecords = {
            stale: {
                id: 'stale',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm-stale',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-stale',
                },
            },
            peer: {
                id: 'peer',
                active: true,
                updatedAt: 2,
                metadata: {
                    machineId: 'm-a',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
            unrelated: {
                id: 'unrelated',
                active: true,
                updatedAt: 3,
                metadata: {
                    machineId: 'm-a',
                    path: '/other',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
        };
        const machineRecords = {
            'm-a': {
                id: 'm-a',
                active: true,
                activeAt: 10,
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result).toBe(sessions);
        expect(getProjectForSession.mock.calls).toEqual([['stale']]);
    });

    it('projects linked direct-session machine targets when top-level machine id is absent', () => {
        const getProjectForSession = vi.fn(() => null);
        const sessions = {
            direct: {
                id: 'direct',
                seq: 1,
                createdAt: 1,
                updatedAt: 10,
                active: false,
                activeAt: 0,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: null,
                    path: '/workspace/direct-repo',
                    homeDir: null,
                    externalSessionV1: {
                        v: 1,
                        agentId: 'codex',
                    },
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'offline' as const,
            },
        };
        const sessionRecords = {
            direct: {
                id: 'direct',
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
        };
        const machineRecords = {
            'm-other': {
                id: 'm-other',
                active: true,
                activeAt: 20,
                metadata: {
                    host: 'other.local',
                    homeDir: '/other',
                },
            },
            'm-direct': {
                id: 'm-direct',
                active: false,
                activeAt: 1,
                metadata: {
                    host: 'direct.local',
                    homeDir: '/workspace',
                },
            },
        };

        const result = applyReachableTargetsToSessionListRenderables({
            sessions: sessions as any,
            sessionRecords: sessionRecords as any,
            machineRecords: machineRecords as any,
            getProjectForSession,
        });

        expect(result.direct?.metadata?.machineId).toBe('m-direct');
        expect(result.direct?.metadata?.path).toBe('/workspace/direct-repo');
    });

});

describe('buildSessionListIndexWithServerScope', () => {
    const baseParams = {
        sessions: {
            visible: {
                id: 'visible',
                seq: 1,
                createdAt: 1,
                updatedAt: 1,
                active: true,
                activeAt: 1,
                metadataVersion: 1,
                agentStateVersion: 0,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
                thinking: false,
                thinkingAt: 0,
                presence: 'online' as const,
            },
        } as any,
        sessionRecords: {
            visible: {
                id: 'visible',
                active: true,
                updatedAt: 1,
                metadata: {
                    machineId: 'm1',
                    path: '/repo',
                    homeDir: '/home/u',
                    host: 'host-a',
                },
            },
        } as any,
        machines: {
            m1: {
                id: 'm1',
                updatedAt: 1,
                active: true,
                activeAt: 1,
                revokedAt: null,
                metadataVersion: 1,
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                    displayName: 'Machine A',
                },
            },
        } as any,
        machineRecords: {
            m1: {
                id: 'm1',
                metadata: {
                    host: 'host-a',
                    homeDir: '/home/u',
                },
            },
        } as any,
        groupInactiveSessionsByProject: false,
        activeGroupingV1: 'date' as const,
        inactiveGroupingV1: 'date' as const,
    };

    it('propagates normalized server scope to every index item', () => {
        const index = buildSessionListIndexWithServerScope({
            ...baseParams,
            serverScope: {
                serverId: ' server-a ',
                serverName: ' Server A ',
            },
        });

        expect(index.length).toBeGreaterThan(0);
        for (const item of index) {
            expect((item as any).serverId).toBe('server-a');
            expect((item as any).serverName).toBe('Server A');
        }
    });

    it('reuses the previous index array when the rebuilt index is unchanged', () => {
        const first = buildSessionListIndexWithServerScope({
            ...baseParams,
            serverScope: {
                serverId: 'server-a',
                serverName: 'Server A',
            },
        });
        const second = buildSessionListIndexWithServerScope({
            ...baseParams,
            previousIndex: first,
            serverScope: {
                serverId: 'server-a',
                serverName: 'Server A',
            },
        });

        expect(second).toBe(first);
    });

    it('builds the active-server index from the current active server snapshot', async () => {
        const previousServerUrl = getServerUrl();

        try {
            setServerUrl('http://localhost:32109');

            const index = buildActiveServerSessionListIndex(baseParams);

            expect(index.some((item) => item.serverId === 'localhost-32109')).toBe(true);
        } finally {
            setServerUrl(previousServerUrl || null);
        }
    });
});
