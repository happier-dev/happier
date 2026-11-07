import { describe, expect, it, vi } from 'vitest';

import { runWithBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

// The host command adapter is the OS/process boundary; keep the Sapling runtime real.
const runScmCommandMock = vi.fn<BackendRuntimeServices['runCommand']>();

const { statMock, readFileMock } = vi.hoisted(() => ({
    statMock: vi.fn(),
    readFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    lstat: statMock,
    readFile: readFileMock,
}));

import { getSaplingSnapshot } from './repository';
import { createSaplingScmBackendRegistration } from './backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

describe('sapling repository snapshot', () => {
    it('throws when `sl status` fails instead of masking the repository as clean', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
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
    }));

    it('marks skipped untracked statistics and totals incomplete', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockReset();
        runScmCommandMock.mockResolvedValue({ success: true, stdout: '', stderr: '', exitCode: 0 });
        runScmCommandMock.mockResolvedValueOnce({ success: true, stdout: '? large.txt\n', stderr: '', exitCode: 0 });
        statMock.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 5_000_001 });
        const snapshot = await getSaplingSnapshot({ cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.sl' } });
        expect.soft(snapshot.entries[0]?.stats).toMatchObject({ isBinary: false, isComplete: false });
        expect.soft(snapshot.totals).toMatchObject({ isComplete: false });
    }));

    it('marks tracked statistics incomplete when the diff command fails', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockReset();
        runScmCommandMock.mockImplementation(async (input: { args: readonly string[] }) => ({
            success: input.args[0] !== 'diff',
            stdout: input.args[0] === 'status' ? 'M mod.txt\n? new.txt\n' : '',
            stderr: input.args[0] === 'diff' ? 'diff failed' : '',
            exitCode: input.args[0] === 'diff' ? 1 : 0,
        }));
        statMock.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 4 });
        readFileMock.mockResolvedValue(Buffer.from('new\n'));
        const snapshot = await getSaplingSnapshot({ cwd: '/repo', projectKey: 'machine:/repo', detection: { isRepo: true, rootPath: '/repo', mode: '.sl' } });
        expect.soft(snapshot.entries.find((entry) => entry.path === 'mod.txt')?.stats.isComplete).toBe(false);
        expect.soft(snapshot.entries.find((entry) => entry.path === 'new.txt')?.stats.isComplete).toBeUndefined();
        expect.soft(snapshot.totals.isComplete).toBe(false);
    }));

    it('captures pending line stats for diffable entries and untracked files', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockReset();
        statMock.mockReset();
        readFileMock.mockReset();

        runScmCommandMock
            .mockResolvedValueOnce({
                success: true,
                stdout: ['M mod.txt', 'A added.txt', '? untracked.txt', 'R removed.txt', ''].join('\n'),
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: '',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: [
                    'diff --git a/mod.txt b/mod.txt',
                    '--- a/mod.txt',
                    '+++ b/mod.txt',
                    '@@ -1 +1,2 @@',
                    '-old',
                    '+new',
                    '+more',
                    'diff --git a/added.txt b/added.txt',
                    'new file mode 100644',
                    '--- /dev/null',
                    '+++ b/added.txt',
                    '@@ -0,0 +1,2 @@',
                    '+hello',
                    '+world',
                    'diff --git a/removed.txt b/removed.txt',
                    'deleted file mode 100644',
                    '--- a/removed.txt',
                    '+++ /dev/null',
                    '@@ -1,2 +0,0 @@',
                    '-gone',
                    '-also gone',
                    '',
                ].join('\n'),
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: [
                    'origin = ssh://example.com/repo',
                    'origin-push = ssh://push.example.com/repo',
                    '',
                ].join('\n'),
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: 'main',
                stderr: '',
                exitCode: 0,
            });

        statMock.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 10 });
        readFileMock.mockResolvedValue(Buffer.from('a\nb\n'));

        const snapshot = await getSaplingSnapshot({
            cwd: '/repo',
            projectKey: 'machine:/repo',
            detection: {
                isRepo: true,
                rootPath: '/repo',
                mode: '.sl',
            },
        });

        const entries = snapshot.entries as Array<{ path: string; stats: { pendingAdded: number; pendingRemoved: number } }>;
        const byPath = new Map(entries.map((e) => [e.path, e]));
        expect(byPath.get('mod.txt')?.stats.pendingAdded).toBe(2);
        expect(byPath.get('mod.txt')?.stats.pendingRemoved).toBe(1);
        expect(byPath.get('added.txt')?.stats.pendingAdded).toBe(2);
        expect(byPath.get('added.txt')?.stats.pendingRemoved).toBe(0);
        expect(byPath.get('removed.txt')?.stats.pendingAdded).toBe(0);
        expect(byPath.get('removed.txt')?.stats.pendingRemoved).toBe(2);
        expect(byPath.get('untracked.txt')?.stats.pendingAdded).toBe(2);
        expect(byPath.get('untracked.txt')?.stats.pendingRemoved).toBe(0);

        expect(snapshot.totals.pendingAdded).toBe(6);
        expect(snapshot.totals.pendingRemoved).toBe(3);
        expect(snapshot.repo.remotes).toEqual([{
            name: 'origin',
            fetchUrl: 'ssh://example.com/repo',
            pushUrl: 'ssh://push.example.com/repo',
        }]);
    }));

    it('reports missing sapling executable as backend unavailable', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockReset();
        runScmCommandMock.mockResolvedValueOnce({
            success: false,
            stdout: '',
            stderr: 'spawn sl ENOENT',
            exitCode: -1,
        });

        const registration = createSaplingScmBackendRegistration();
        const result = await registration.handlers.read?.statusSnapshot?.({
            context: {
                cwd: '/repo',
                projectKey: 'machine:/repo',
                detection: {
                    isRepo: true,
                    rootPath: '/repo',
                    mode: '.sl',
                },
            },
            request: { cwd: '/repo' },
        });

        expect(result?.success).toBe(false);
        expect(result?.errorCode).toBe(SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE);
    }));

    it('reports sapling remote path read failures instead of masking them as no remotes', async () => runWithBackendRuntimeServices({ runCommand: runScmCommandMock }, async () => {
        runScmCommandMock.mockReset();
        statMock.mockReset();
        readFileMock.mockReset();

        runScmCommandMock
            .mockResolvedValueOnce({
                success: true,
                stdout: '',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: '',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: true,
                stdout: '',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                success: false,
                stdout: '',
                stderr: 'abort: failed to read paths',
                exitCode: 1,
            });

        const registration = createSaplingScmBackendRegistration();
        const result = await registration.handlers.read?.statusSnapshot?.({
            context: {
                cwd: '/repo',
                projectKey: 'machine:/repo',
                detection: {
                    isRepo: true,
                    rootPath: '/repo',
                    mode: '.sl',
                },
            },
            request: { cwd: '/repo' },
        });

        expect(result?.success).toBe(false);
        expect(result?.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        expect(result?.error).toContain('failed to read paths');
    }));
});
