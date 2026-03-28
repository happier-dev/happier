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

describe('resolveRepoScmMachinePathRequest', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('trims machine/path input and resolves tilde paths against the machine home directory', async () => {
        storageGetStateMock.mockReturnValue({
            machines: {
                'machine-a': {
                    id: 'machine-a',
                    metadata: {
                        homeDir: '/Users/tester',
                    },
                },
            },
        } as any);

        const { resolveRepoScmMachinePathRequest } = await import('./resolveRepoScmMachinePathRequest');
        expect(resolveRepoScmMachinePathRequest({
            machineId: '  machine-a  ',
            path: '  ~/repo  ',
        })).toEqual({
            machineId: 'machine-a',
            resolvedPath: '/Users/tester/repo',
            repoIdentityKey: 'machine-a:/Users/tester/repo',
        });
    });

    it('returns null when machine or path is blank after trimming', async () => {
        const { resolveRepoScmMachinePathRequest } = await import('./resolveRepoScmMachinePathRequest');

        expect(resolveRepoScmMachinePathRequest({
            machineId: '   ',
            path: '/repo',
        })).toBeNull();
        expect(resolveRepoScmMachinePathRequest({
            machineId: 'machine-a',
            path: '   ',
        })).toBeNull();
    });
});
