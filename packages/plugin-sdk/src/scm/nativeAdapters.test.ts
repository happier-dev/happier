import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalAbsolutePathsEqual } from '@happier-dev/plugin-sdk/fs';
import { parseGitComparisonOutput } from '@happier-dev/plugin-sdk/scm';
import { createGitTemporaryIndex, resolveGitIndexPath, type GitTemporaryIndexCommandAdapter } from '@happier-dev/plugin-sdk/scm/git';

describe('public native SCM adapters', () => {
    it('isolates a real Git index and preserves literal renamed comparison paths', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'happier-sdk-native-scm-'));
        const git = (args: readonly string[], env?: Record<string, string | undefined>, stdin?: string) => execFileSync('git', [...args], {
            cwd, env: { ...process.env, ...env }, input: stdin, encoding: 'utf8',
        });
        const runGit: GitTemporaryIndexCommandAdapter = async ({ args, env, stdin }) => ({
            success: true, stdout: git(args, env, stdin), stderr: '', exitCode: 0,
        });
        try {
            git(['init', '-q']);
            writeFileSync(join(cwd, 'before name.txt'), 'retained content\n');
            git(['add', '.']);
            const baseTree = git(['write-tree']).trim();
            const result = await createGitTemporaryIndex({ cwd, runGit, seed: { kind: 'tree', treeOid: baseTree } });
            if (!result.success) throw new Error(result.error);
            try {
                git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', 'before name.txt']).trim()},after\tname.txt`], result.tempIndex.env);
                git(['update-index', '--force-remove', 'before name.txt'], result.tempIndex.env);
                expect(git(['write-tree']).trim()).toBe(baseTree);
                const comparison = parseGitComparisonOutput(git(['diff', '--cached', '--raw', '-z', '--patch', '--find-renames', baseTree], result.tempIndex.env));
                expect(comparison.error).toBeUndefined();
                expect(comparison.files).toMatchObject([{ path: 'after\tname.txt', previousPath: 'before name.txt', changeKind: 'renamed' }]);
                expect(comparison.sections).toHaveLength(1);
                await expect(resolveGitIndexPath({ cwd, runGit })).resolves.toEqual({ success: true, indexPath: join(cwd, '.git', 'index') });
            } finally {
                await result.tempIndex.cleanup();
            }
            expect(existsSync(result.tempIndex.indexPath)).toBe(false);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });

    it('uses shared cross-platform path identity without sibling-prefix matches', () => {
        expect(canonicalAbsolutePathsEqual('C:\\Users\\alice\\repo', 'C:/Users/alice/repo/')).toBe(true);
        expect(canonicalAbsolutePathsEqual('C:\\Users\\alice', 'C:/Users/alice2')).toBe(false);
    });
});
