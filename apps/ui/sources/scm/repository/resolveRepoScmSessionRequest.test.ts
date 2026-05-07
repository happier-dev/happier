import { afterEach, describe, expect, it, vi } from 'vitest';

import { installRepositoryScmCommonModuleMocks } from './repositoryScmTestHelpers';
import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';

const storageGetStateMock = vi.hoisted(() => vi.fn());

installRepositoryScmCommonModuleMocks({
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        storage: {
            getState: storageGetStateMock,
        },
    }),
});

describe('resolveRepoScmSessionRequest', () => {
    afterEach(() => {
        storageGetStateMock.mockReset();
        storageGetStateMock.mockReturnValue({});
        vi.restoreAllMocks();
    });

    it('resolves the canonical machine/path identity for a session-backed repo', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    activeAt: 42,
                    metadata: {
                        homeDir: '/Users/tester',
                        host: 'mbp.local',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: false,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'machine-a',
                        path: '~/repo',
                        host: 'mbp.local',
                    },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session_1'
                ? {
                    key: {
                        machineId: 'machine-a',
                        path: '/Users/tester/repo',
                    },
                }
                : null,
        } as any);

        const { resolveRepoScmSessionRequest } = await import('./resolveRepoScmSessionRequest');
        expect(resolveRepoScmSessionRequest({ sessionId: 'session_1' })).toEqual({
            sessionId: 'session_1',
            machineId: 'machine-a',
            resolvedPath: '/Users/tester/repo',
            repoIdentityKey: 'machine-a:/Users/tester/repo',
        });
    });

    it('resolves direct-session machine/path identity when only the direct link has a machine id', async () => {
        storageGetStateMock.mockReturnValue({
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: false,
                    updatedAt: 100,
                    metadata: {
                        path: '/Users/tester/direct-repo',
                        directSessionV1: {
                            v: 1,
                            providerId: 'codex',
                            machineId: 'machine-direct',
                            remoteSessionId: 'remote-1',
                            source: { kind: 'codexHome', home: 'user' },
                        },
                    },
                },
            },
            machines: {},
            getProjectForSession: () => null,
        } as any);

        const { resolveRepoScmSessionRequest } = await import('./resolveRepoScmSessionRequest');
        expect(resolveRepoScmSessionRequest({ sessionId: 'session_1' })).toEqual({
            sessionId: 'session_1',
            machineId: 'machine-direct',
            resolvedPath: '/Users/tester/direct-repo',
            repoIdentityKey: 'machine-direct:/Users/tester/direct-repo',
        });
    });

    it('prefers the session workspace path over the project path for worktree sessions', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    activeAt: 42,
                    metadata: {
                        homeDir: '/Users/tester',
                        host: 'mbp.local',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: true,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'machine-a',
                        path: '~/repo/.dev/worktree/gentle-meadow',
                        host: 'mbp.local',
                    },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session_1'
                ? {
                    key: {
                        machineId: 'machine-a',
                        path: '/Users/tester/repo',
                    },
                }
                : null,
        } as any);

        const { resolveRepoScmSessionRequest } = await import('./resolveRepoScmSessionRequest');
        expect(resolveRepoScmSessionRequest({ sessionId: 'session_1' })).toEqual({
            sessionId: 'session_1',
            machineId: 'machine-a',
            resolvedPath: '/Users/tester/repo/.dev/worktree/gentle-meadow',
            repoIdentityKey: 'machine-a:/Users/tester/repo/.dev/worktree/gentle-meadow',
        });
    });

    it('keeps using the project path for inactive sessions when the session path is stale', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    activeAt: 42,
                    metadata: {
                        homeDir: '/Users/tester',
                        host: 'mbp.local',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: false,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'machine-a',
                        path: '/Users/tester/stale-repo',
                        host: 'mbp.local',
                    },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session_1'
                ? {
                    key: {
                        machineId: 'machine-a',
                        path: '/Users/tester/live-repo',
                    },
                }
                : null,
        } as any);

        const { resolveRepoScmSessionRequest } = await import('./resolveRepoScmSessionRequest');
        expect(resolveRepoScmSessionRequest({ sessionId: 'session_1' })).toEqual({
            sessionId: 'session_1',
            machineId: 'machine-a',
            resolvedPath: '/Users/tester/live-repo',
            repoIdentityKey: 'machine-a:/Users/tester/live-repo',
        });
    });

    it('normalizes Windows home-relative workspace paths before building the repo identity key', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    active: true,
                    activeAt: 42,
                    metadata: {
                        homeDir: 'C:\\Users\\tester',
                        host: 'windows-box.local',
                    },
                },
            },
            sessions: {
                session_1: {
                    id: 'session_1',
                    active: false,
                    updatedAt: 100,
                    metadata: {
                        machineId: 'machine-a',
                        path: '~\\repo\\subdir',
                        homeDir: 'C:\\Users\\tester',
                        host: 'windows-box.local',
                    },
                },
            },
            getProjectForSession: (sessionId: string) => sessionId === 'session_1'
                ? {
                    key: {
                        machineId: 'machine-a',
                        path: '~/repo/subdir',
                    },
                }
                : null,
        } as any);

        const { resolveRepoScmSessionRequest } = await import('./resolveRepoScmSessionRequest');
        expect(resolveRepoScmSessionRequest({ sessionId: 'session_1' })).toEqual({
            sessionId: 'session_1',
            machineId: 'machine-a',
            resolvedPath: 'C:\\Users\\tester\\repo\\subdir',
            repoIdentityKey: 'machine-a:C:\\Users\\tester\\repo\\subdir',
        });
    });
});
