import type { ScmChangeApplyResponse } from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runScmCommand } from '../runtime.js';

type GitPatchTarget = 'index' | 'worktree';

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function splitPatchFiles(lines: string[]): string[][] {
    const gitBoundaries = lines.flatMap((line, index) => line.startsWith('diff --git ') ? [index] : []);
    const boundaries = gitBoundaries.length ? gitBoundaries : [];
    if (!gitBoundaries.length) {
        let oldRemaining = 0;
        let newRemaining = 0;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!;
            const hunk = HUNK_HEADER.exec(line);
            if (hunk) {
                oldRemaining = Number(hunk[2] ?? 1);
                newRemaining = Number(hunk[4] ?? 1);
            } else if (oldRemaining <= 0 && newRemaining <= 0 && line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
                boundaries.push(index);
                index += 1;
            } else {
                if (line.startsWith(' ') || line.startsWith('-')) oldRemaining -= 1;
                if (line.startsWith(' ') || line.startsWith('+')) newRemaining -= 1;
            }
        }
    }
    if (!boundaries.length) return [lines];
    boundaries[0] = 0;
    return boundaries.map((start, index) => lines.slice(start, boundaries[index + 1]));
}

/** Validate against the source coordinates; Git normally searches from the other side's coordinates. */
async function bindExactPatchLocations(input: {
    cwd: string;
    patch: string;
    reverse?: boolean;
    env?: Record<string, string | undefined>;
}): Promise<{ success: true; patch: string } | { success: false; error: string }> {
    const run = (args: string[], stdin?: string) => runScmCommand({ bin: 'git', cwd: input.cwd, args, stdin, env: input.env, timeoutMs: 15_000 });
    const blocks = splitPatchFiles(input.patch.split('\n'));
    for (const lines of blocks) {
        const hunkIndices = lines.flatMap((line, index) => HUNK_HEADER.test(line) ? [index] : []);
        // Binary and metadata-only patches have no textual occurrence to relocate; Git validates them.
        if (!hunkIndices.length) continue;
        // Git owns quoted/escaped filenames and rename paths. Invert the patch to ask for its source path.
        const filePatch = lines.join('\n');
        const paths = await run(['apply', '--numstat', '-z', '--unidiff-zero', '--recount', ...(input.reverse ? [] : ['--reverse']), '-'], filePatch.endsWith('\n') ? filePatch : filePatch + '\n');
        if (!paths.success) return { success: false, error: paths.stderr || 'Could not resolve patch source path' };
        const records = paths.stdout.split('\0').filter(Boolean);
        const path = records.length === 1 ? /^\d+\t\d+\t([\s\S]+)$/.exec(records[0]!)?.[1] : undefined;
        if (!path) return { success: false, error: 'Could not resolve one exact patch source path' };
        const sourceHeader = input.reverse ? '+++ /dev/null' : '--- /dev/null';
        let content = '';
        if (!lines.some((line) => line === sourceHeader || line === `${sourceHeader}\r`)) {
            const source = await run(['show', `:0:${path}`]);
            if (!source.success) return { success: false, error: source.stderr || 'Could not read patch source from the index' };
            content = source.stdout;
        }
        const sourceLines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        let previousEnd = 0;
        let delta = 0;
        for (let hunkIndex = 0; hunkIndex < hunkIndices.length; hunkIndex += 1) {
            const headerIndex = hunkIndices[hunkIndex]!;
            const header = HUNK_HEADER.exec(lines[headerIndex]!)!;
            const oldLines: string[] = [];
            const newLines: string[] = [];
            let previousOld = false;
            let previousNew = false;
            for (let index = headerIndex + 1; index < (hunkIndices[hunkIndex + 1] ?? lines.length); index += 1) {
                const line = lines[index]!;
                if (line === '\\ No newline at end of file' || line === '\\ No newline at end of file\r') {
                    if (previousOld) oldLines[oldLines.length - 1] = oldLines.at(-1)!.replace(/\n$/, '');
                    if (previousNew) newLines[newLines.length - 1] = newLines.at(-1)!.replace(/\n$/, '');
                    continue;
                }
                if (![' ', '-', '+'].includes(line[0] ?? '')) break;
                previousOld = line[0] !== '+';
                previousNew = line[0] !== '-';
                const text = line.slice(1) + '\n';
                if (previousOld) oldLines.push(text);
                if (previousNew) newLines.push(text);
            }
            const before = input.reverse ? newLines : oldLines;
            const after = input.reverse ? oldLines : newLines;
            const start = Number(input.reverse ? header[3] : header[1]);
            const offset = before.length ? start - 1 : start;
            if (!Number.isSafeInteger(offset) || offset < previousEnd || offset > sourceLines.length ||
                before.some((line, index) => sourceLines[offset + index] !== line)) {
                return { success: false, error: 'Patch hunk does not match its exact source location' };
            }
            previousEnd = offset + before.length;
            // Git starts at newpos - 1, including deletions. Bind that search to the validated occurrence.
            const destinationStart = offset + delta + 1;
            lines[headerIndex] = input.reverse
                ? `@@ -${destinationStart},${after.length} +${start},${before.length} @@${header[5]}`
                : `@@ -${start},${before.length} +${destinationStart},${after.length} @@${header[5]}`;
            delta += after.length - before.length;
        }
    }
    return { success: true, patch: blocks.map((lines) => lines.join('\n')).join('\n') };
}

function buildGitApplyArgs(input: {
    target: GitPatchTarget;
    reverse?: boolean;
    check?: boolean;
}): string[] {
    const args = ['apply'];
    if (input.check) {
        args.push('--check');
    }
    if (input.target === 'index') {
        args.push('--cached');
    }
    if (input.reverse) {
        args.push('--reverse');
    }
    args.push('--unidiff-zero', '--recount', '--whitespace=nowarn', '-');
    return args;
}

export async function applyValidatedGitPatch(input: {
    cwd: string;
    patch: string;
    target: GitPatchTarget;
    reverse?: boolean;
    env?: Record<string, string | undefined>;
    checkOnly?: boolean;
    checkError?: string;
    applyError?: string;
}): Promise<ScmChangeApplyResponse> {
    const check = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: buildGitApplyArgs({
            target: input.target,
            reverse: input.reverse,
            check: true,
        }),
        stdin: input.patch,
        timeoutMs: 15_000,
        env: input.env,
    });
    if (!check.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: check.stderr || input.checkError || 'Patch check failed',
            stderr: check.stderr,
        };
    }

    // Worktree contents use Git's filter/EOL conversion; exact locations here are bound to index blobs.
    const exact = input.target === 'index'
        ? await bindExactPatchLocations(input)
        : { success: true as const, patch: input.patch };
    if (!exact.success) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED, error: exact.error };
    }
    if (exact.patch !== input.patch) {
        const exactCheck = await runScmCommand({
            bin: 'git', cwd: input.cwd,
            args: buildGitApplyArgs({ target: input.target, reverse: input.reverse, check: true }),
            stdin: exact.patch, timeoutMs: 15_000, env: input.env,
        });
        if (!exactCheck.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: exactCheck.stderr || input.checkError || 'Patch check failed', stderr: exactCheck.stderr };
    }

    if (input.checkOnly) return { success: true };

    const apply = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: buildGitApplyArgs({
            target: input.target,
            reverse: input.reverse,
        }),
        stdin: exact.patch,
        timeoutMs: 15_000,
        env: input.env,
    });
    return apply.success
        ? { success: true, stdout: apply.stdout, stderr: apply.stderr }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED,
            error: apply.stderr || input.applyError || 'Patch apply failed',
            stderr: apply.stderr,
        };
}
