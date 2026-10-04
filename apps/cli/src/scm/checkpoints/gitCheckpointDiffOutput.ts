import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScmExecResult } from '../runtime';
import { runGitCheckpointCommand } from './gitCheckpointCommands';

/** Git owns streaming output to disk; command stdout limits must not discard readable objects. */
export async function readGitCheckpointDiffOutput(input: Readonly<{
    cwd: string;
    args: readonly string[];
}>): Promise<ScmExecResult> {
    const directory = await mkdtemp(join(tmpdir(), 'happier-checkpoint-diff-'));
    const outputPath = join(directory, 'diff');
    try {
        const result = await runGitCheckpointCommand({ cwd: input.cwd,
            args: ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `--output=${outputPath}`, ...input.args] });
        if (!result.success) return result;
        return { ...result, stdout: await readFile(outputPath, 'utf8') };
    } catch (error) {
        return { success: false, stdout: '', stderr: error instanceof Error ? error.message : 'Checkpoint diff output could not be read', exitCode: -1 };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
