import { describe, expect, it, vi } from 'vitest';

const { runScmCommandMock } = vi.hoisted(() => ({
    runScmCommandMock: vi.fn(),
}));

vi.mock('../../runtime', () => ({
    runScmCommand: runScmCommandMock,
}));

import { getSaplingSnapshot } from './repository';

describe('sapling repository snapshot', () => {
    it('throws when `sl status` fails instead of masking the repository as clean', async () => {
        runScmCommandMock.mockReset();
        runScmCommandMock.mockResolvedValueOnce({
            success: false,
            stdout: '',
            stderr: 'abort: status failed',
            exitCode: 1,
        });
        runScmCommandMock.mockResolvedValueOnce({
            success: true,
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
        runScmCommandMock.mockResolvedValueOnce({
            success: true,
            stdout: '000000000000',
            stderr: '',
            exitCode: 0,
        });

        await expect(
            getSaplingSnapshot({
                cwd: '/repo',
                projectKey: 'machine:/repo',
                detection: {
                    isRepo: true,
                    rootPath: '/repo',
                    mode: '.sl',
                },
            }),
        ).rejects.toThrow('abort: status failed');
    });
});
