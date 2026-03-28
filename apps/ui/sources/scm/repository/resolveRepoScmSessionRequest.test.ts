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
});
