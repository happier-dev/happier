import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: vi.fn(),
    },
}));

describe('resolveRepoScmMachinePathRequest', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('trims machine/path input and resolves tilde paths against the machine home directory', async () => {
        vi.mocked(storage.getState).mockReturnValue({
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
