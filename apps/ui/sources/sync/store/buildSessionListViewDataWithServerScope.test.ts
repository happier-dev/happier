import { describe, expect, it, vi } from 'vitest';

import { applyReachableTargetsToSessionListRenderables } from './buildSessionListViewDataWithServerScope';

describe('applyReachableTargetsToSessionListRenderables', () => {
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

    it('reuses visible-session project lookups when peer fallback is needed for another row', () => {
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

        expect(result).not.toBe(sessions);
        expect(getProjectForSession.mock.calls).toEqual([['direct'], ['stale'], ['peer']]);
    });

    it('skips unrelated peer project lookups when explicit peer metadata path cannot match unresolved rows', () => {
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

        expect(result).not.toBe(sessions);
        expect(getProjectForSession.mock.calls).toEqual([['stale']]);
    });

});
