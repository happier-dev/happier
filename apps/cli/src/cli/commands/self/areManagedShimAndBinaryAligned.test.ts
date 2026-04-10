import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readFileSyncMock, realpathSyncMock } = vi.hoisted(() => ({
    readFileSyncMock: vi.fn(),
    realpathSyncMock: vi.fn(),
}));

vi.mock('node:fs', () => ({
    readFileSync: readFileSyncMock,
    realpathSync: realpathSyncMock,
}));

describe('areManagedShimAndBinaryAligned', () => {
    beforeEach(() => {
        readFileSyncMock.mockReset();
        realpathSyncMock.mockReset();
    });

    it('treats Windows copy-based shims as aligned when the shim and binary contents match', async () => {
        readFileSyncMock
            .mockReturnValueOnce(Buffer.from('shim-binary'))
            .mockReturnValueOnce(Buffer.from('shim-binary'));

        const { areManagedShimAndBinaryAligned } = await import('./areManagedShimAndBinaryAligned.js');
        expect(areManagedShimAndBinaryAligned({
            shimPath: 'C:/Users/tester/.happier/bin/happier.exe',
            binaryPath: 'C:/Users/tester/.happier/cli-preview/current/happier.exe',
            platform: 'win32',
        })).toBe(true);
        expect(realpathSyncMock).not.toHaveBeenCalled();
    });

    it('uses realpath alignment for symlink-based shims on non-Windows platforms', async () => {
        realpathSyncMock
            .mockReturnValueOnce('/Users/tester/.happier/cli-preview/current/happier')
            .mockReturnValueOnce('/Users/tester/.happier/cli-preview/current/happier');

        const { areManagedShimAndBinaryAligned } = await import('./areManagedShimAndBinaryAligned.js');
        expect(areManagedShimAndBinaryAligned({
            shimPath: '/Users/tester/.happier/bin/happier',
            binaryPath: '/Users/tester/.happier/cli-preview/current/happier',
            platform: 'darwin',
        })).toBe(true);
        expect(readFileSyncMock).not.toHaveBeenCalled();
    });
});
