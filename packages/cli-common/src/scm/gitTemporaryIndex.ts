import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type GitTemporaryIndexCommand = Readonly<{
    cwd: string;
    args: readonly string[];
    stdin?: string;
    env?: Record<string, string | undefined>;
}>;

export type GitTemporaryIndexCommandResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
}>;

export type GitTemporaryIndexCommandAdapter = (
    input: GitTemporaryIndexCommand,
) => Promise<GitTemporaryIndexCommandResult>;

export type GitTemporaryIndexSeed =
    | Readonly<{ kind: 'empty' }>
    | Readonly<{ kind: 'tree'; treeOid: string }>
    | Readonly<{ kind: 'current-index' }>;

export type GitTemporaryIndex = Readonly<{
    indexPath: string;
    env: Record<string, string>;
    cleanup: () => void;
}>;

export type GitTemporaryIndexFailure = Readonly<{
    success: false;
    error: string;
    commandResult?: GitTemporaryIndexCommandResult;
}>;

export async function resolveGitIndexPath(input: Readonly<{
    cwd: string;
    runGit: GitTemporaryIndexCommandAdapter;
}>): Promise<Readonly<{ success: true; indexPath: string }> | GitTemporaryIndexFailure> {
    const result = await input.runGit({ cwd: input.cwd, args: ['rev-parse', '--git-path', 'index'] });
    const rawPath = result.stdout.trim();
    if (!result.success || !rawPath) {
        return { success: false, error: result.stderr || 'Failed to resolve repository index path', commandResult: result };
    }
    return { success: true, indexPath: isAbsolute(rawPath) ? rawPath : resolve(input.cwd, rawPath) };
}

export async function createGitTemporaryIndex(input: Readonly<{
    cwd: string;
    runGit: GitTemporaryIndexCommandAdapter;
    seed: GitTemporaryIndexSeed;
}>): Promise<Readonly<{ success: true; tempIndex: GitTemporaryIndex }> | GitTemporaryIndexFailure> {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-scm-index-'));
    const indexPath = join(tempDir, 'index');
    const env = { GIT_INDEX_FILE: indexPath };
    const cleanup = () => rmSync(tempDir, { recursive: true, force: true });
    let retained = false;
    try {
        let initializeEmpty = input.seed.kind === 'empty';
        if (input.seed.kind === 'current-index') {
            const sourceIndex = await resolveGitIndexPath(input);
            if (!sourceIndex.success) return sourceIndex;
            try {
                copyFileSync(sourceIndex.indexPath, indexPath);
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
                initializeEmpty = true;
            }
            if (!initializeEmpty) {
                // A snapshot must not depend on a shared-index file Git can retire.
                const result = await input.runGit({ cwd: input.cwd, args: ['update-index', '--no-split-index'], env });
                if (!result.success) {
                    return { success: false, error: result.stderr || 'Failed to snapshot repository index', commandResult: result };
                }
            }
        }
        if (input.seed.kind === 'tree' || initializeEmpty) {
            const result = await input.runGit({
                cwd: input.cwd,
                args: input.seed.kind === 'tree' ? ['read-tree', input.seed.treeOid] : ['read-tree', '--empty'],
                env,
            });
            if (!result.success) {
                return { success: false, error: result.stderr || 'Failed to initialize temporary Git index', commandResult: result };
            }
        }
        retained = true;
        return { success: true, tempIndex: { indexPath, env, cleanup } };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
        if (!retained) cleanup();
    }
}
