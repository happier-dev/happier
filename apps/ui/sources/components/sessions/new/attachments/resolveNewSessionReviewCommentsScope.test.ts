import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveNewSessionReviewCommentsScope } from './resolveNewSessionReviewCommentsScope';

const readCachedSnapshotForMachinePathMock = vi.hoisted(() => vi.fn());

vi.mock('@/scm/scmRepositoryService', () => ({
    scmRepositoryService: {
        readCachedSnapshotForMachinePath: (...args: unknown[]) => readCachedSnapshotForMachinePathMock(...args),
    },
}));

describe('resolveNewSessionReviewCommentsScope', () => {
    beforeEach(() => {
        readCachedSnapshotForMachinePathMock.mockReset();
    });

    it('prefers the cached project root over a selected subdirectory when available', () => {
        readCachedSnapshotForMachinePathMock.mockReturnValue({
            repo: {
                isRepo: true,
                rootPath: '/repo',
            },
        });

        expect(resolveNewSessionReviewCommentsScope({
            targetServerId: 'server-a',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/subdir',
        })).toEqual({
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        });
    });

    it('falls back to the selected path when no cached project root is available', () => {
        readCachedSnapshotForMachinePathMock.mockReturnValue(null);

        expect(resolveNewSessionReviewCommentsScope({
            targetServerId: 'server-a',
            selectedMachineId: 'machine-1',
            selectedPath: '/repo/subdir',
        })).toEqual({
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo/subdir',
        });
    });
});
