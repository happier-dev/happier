import { describe, expect, it, vi } from 'vitest';

import type { ScmBackendContext } from '../../../types';

const runScmCommandSpy = vi.fn();

vi.mock('../../../runtime', async () => {
    const actual = await vi.importActual<any>('../../../runtime');
    return {
        ...actual,
        runScmCommand: (input: any) => runScmCommandSpy(input),
    };
});

describe('gitDiffFile (untracked)', () => {
    it('falls back to a no-index diff for untracked files when normal diff is empty', async () => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy
            // Normal diff returns empty.
            .mockResolvedValueOnce({ success: true, stdout: '', stderr: '', exitCode: 0 })
            // Detect untracked file.
            .mockResolvedValueOnce({ success: true, stdout: 'Dockerfile\n', stderr: '', exitCode: 0 })
            // no-index diff returns synthetic add diff (git diff exits 1 when differences exist).
            .mockResolvedValueOnce({ success: false, stdout: 'diff --git a/Dockerfile b/Dockerfile\n', stderr: '', exitCode: 1 });

        const { gitDiffFile } = await import('./readOperations');

        const context: ScmBackendContext = {
            cwd: '/repo/subdir',
            projectKey: 'machine:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
        };

        const res = await gitDiffFile({
            context,
            request: { path: 'Dockerfile', area: 'pending' },
        });

        expect(res.success).toBe(true);
        if (!res.success) return;
        expect(res.diff).toContain('diff --git a/Dockerfile b/Dockerfile');

        expect(runScmCommandSpy).toHaveBeenCalledTimes(3);
        expect(runScmCommandSpy.mock.calls[1]?.[0]).toMatchObject({
            bin: 'git',
            cwd: '/repo',
            args: ['ls-files', '--others', '--exclude-standard', '--', 'Dockerfile'],
        });
        expect(runScmCommandSpy.mock.calls[2]?.[0]).toMatchObject({
            bin: 'git',
            cwd: '/repo',
            args: ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', 'Dockerfile'],
        });
    });

    it('treats git diff exit code 1 (changes) as success for regular tracked diffs', async () => {
        runScmCommandSpy.mockReset();
        runScmCommandSpy.mockResolvedValueOnce({
            success: false,
            stdout: 'diff --git a/a.txt b/a.txt\n',
            stderr: '',
            exitCode: 1,
        });

        const { gitDiffFile } = await import('./readOperations');

        const context: ScmBackendContext = {
            cwd: '/repo',
            projectKey: 'machine:/repo',
            detection: { isRepo: true, rootPath: '/repo', mode: '.git' },
        };

        const res = await gitDiffFile({
            context,
            request: { path: 'a.txt', area: 'pending' },
        });

        expect(res.success).toBe(true);
        if (!res.success) return;
        expect(res.diff).toContain('diff --git a/a.txt b/a.txt');

        expect(runScmCommandSpy).toHaveBeenCalledTimes(1);
        const call = runScmCommandSpy.mock.calls[0]?.[0];
        expect(call).toMatchObject({ bin: 'git', cwd: '/repo' });
        expect(call?.args?.slice?.(0, 3)).toEqual(['diff', '--no-ext-diff', '--']);
        expect(String(call?.args?.[call.args.length - 1] ?? '')).toContain('a.txt');
    });
});
