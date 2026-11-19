import { isAbsolute, join, resolve } from 'node:path';

import type { ScmOperationRepositoryState, ScmOperationState } from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';

type GitStatePaths = ReadonlyMap<string, string | null>;

async function resolveGitStatePaths(context: ScmBackendContext, statePaths: readonly string[]): Promise<GitStatePaths> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', ...statePaths.flatMap(statePath => ['--git-path', statePath])],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) throw Object.assign(new Error(result.stderr || 'Failed to inspect Git operation state'), { errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED });
    const rawPaths = statePaths.length === 1 ? [result.stdout.trim()] : result.stdout.trim().split(/\r?\n/);
    // rev-parse has no NUL-delimited path output. Resolve separately only when
    // a checkout name contains a newline and makes the batch ambiguous.
    if (rawPaths.length !== statePaths.length) {
        return new Map(await Promise.all(statePaths.map(async statePath => [statePath, await resolveGitStatePath(context, statePath)] as const)));
    }
    const paths = readRepositoryFileSystem().commandPaths;
    return new Map(statePaths.map((statePath, index) => {
        const rawPath = rawPaths[index].trim();
        return [statePath, rawPath ? (isAbsolute(rawPath) ? paths?.fromCommandPath(rawPath) ?? rawPath : resolve(context.cwd, rawPath)) : null];
    }));
}

export async function resolveGitStatePath(context: ScmBackendContext, statePath: string): Promise<string | null> {
    return (await resolveGitStatePaths(context, [statePath])).get(statePath) ?? null;
}

async function directoryExists(path: string): Promise<boolean> {
    try {
        return (await readRepositoryFileSystem().stat(path)).isDirectory();
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function readTrimmedFile(path: string, format: 'trimmed' | 'raw' = 'trimmed'): Promise<string | null> {
    try {
        const content = Buffer.from(await readRepositoryFileSystem().readFile(path)).toString('utf8');
        if (format === 'raw') return content;
        const value = content.trim();
        return value || null;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}

function parseMergeSourceRef(message: string | null): string | null {
    if (!message) return null;
    const firstLine = message.split(/\r?\n/g).find((line) => line.trim())?.trim() ?? '';
    const quoted = firstLine.match(/'([^']+)'/);
    if (quoted?.[1]) return quoted[1];
    return firstLine || null;
}

async function readResolvedStateFile(paths: GitStatePaths, name: string, format: 'trimmed' | 'raw' = 'trimmed'): Promise<string | null> {
    const path = paths.get(name);
    return path ? readTrimmedFile(path, format) : null;
}

async function readMergeOperationState(context: ScmBackendContext, paths: GitStatePaths): Promise<ScmOperationState | null> {
    const mergeHead = await readResolvedStateFile(paths, 'MERGE_HEAD');
    if (!mergeHead) {
        return null;
    }

    const sourceRef = parseMergeSourceRef(await readResolvedStateFile(paths, 'MERGE_MSG')) ?? mergeHead;
    const mergeHeads = mergeHead.split(/\s+/);
    const bases = mergeHeads.length === 1 ? await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['merge-base', '--all', 'HEAD', mergeHeads[0]], timeoutMs: 10_000, env: buildScmNonInteractiveEnv() }) : null;
    const baseOids = bases?.success ? bases.stdout.trim().split(/\s+/).filter(Boolean) : [];
    return {
        kind: 'merge',
        sourceRef,
        ...(baseOids.length === 1 ? { baseOid: baseOids[0] } : {}),
        canContinue: false,
        canAbort: true,
    };
}

async function readRebaseSourceRef(rebasePath: string): Promise<string | null> {
    const ontoName = await readTrimmedFile(join(rebasePath, 'onto_name'));
    if (ontoName && ontoName !== 'onto') return ontoName.replace(/^refs\/heads\//, '');

    const headName = await readTrimmedFile(join(rebasePath, 'head-name'));
    return headName ? headName.replace(/^refs\/heads\//, '') : null;
}

async function readRebaseOperationState(paths: GitStatePaths): Promise<ScmOperationState | null> {
    for (const rebaseDirName of ['rebase-merge', 'rebase-apply'] as const) {
        const rebasePath = paths.get(rebaseDirName);
        if (!rebasePath || !(await directoryExists(rebasePath))) {
            continue;
        }
        return {
            kind: 'rebase',
            sourceRef: await readRebaseSourceRef(rebasePath),
            replayCommit: await readResolvedStateFile(paths, 'REBASE_HEAD') ?? await readTrimmedFile(join(rebasePath, 'stopped-sha')) ?? await readTrimmedFile(join(rebasePath, 'original-commit')) ?? undefined,
            baseOid: await readTrimmedFile(join(rebasePath, 'onto')) ?? undefined,
            canContinue: false,
            canAbort: true,
        };
    }

    return null;
}

export async function readGitBranchOperationState(context: ScmBackendContext, knownHeadOid?: string): Promise<ScmOperationState | null> {
    const paths = await resolveGitStatePaths(context, ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'MERGE_MSG', 'REBASE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD', 'sequencer/todo']);
    // A rebase directory controls its replay even when another head marker remains.
    const state = (await readRebaseOperationState(paths)) ?? (await readMergeOperationState(context, paths)) ?? (await readReplayOperationState(context, paths));
    if (!state) return null;
    const conflicts = await readGitConflictEntries(context);
    return { ...state, headOid: knownHeadOid ?? await readHeadOid(context), conflicts, unresolvedCount: conflicts.length, canContinue: conflicts.length === 0, canSkip: state.kind !== 'merge' && Boolean(state.replayCommit) };
}

export async function readGitStateFile(context: ScmBackendContext, name: string, format: 'trimmed' | 'raw' = 'trimmed') {
    return readResolvedStateFile(await resolveGitStatePaths(context, [name]), name, format);
}

async function readHeadOid(context: ScmBackendContext) {
    const result = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', 'HEAD'], timeoutMs: 10_000, env: buildScmNonInteractiveEnv() });
    return result.success ? result.stdout.trim() || undefined : undefined;
}

async function readReplayOperationState(context: ScmBackendContext, paths: GitStatePaths): Promise<ScmOperationState | null> {
    const revertHead = await readResolvedStateFile(paths, 'REVERT_HEAD');
    const pickHead = revertHead ? null : await readResolvedStateFile(paths, 'CHERRY_PICK_HEAD');
    if (revertHead || pickHead) return { kind: revertHead ? 'revert' : 'cherry_pick', replayCommit: revertHead ?? pickHead ?? undefined, canContinue: false, canAbort: true };
    const todo = await readResolvedStateFile(paths, 'sequencer/todo');
    const step = todo?.split(/\r?\n/).find((line) => /^(pick|revert)\s/.test(line));
    if (!step) return null;
    const commit = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', `${step.split(/\s+/)[1]}^{commit}`], timeoutMs: 10_000, env: buildScmNonInteractiveEnv() });
    return { kind: step.startsWith('revert ') ? 'revert' : 'cherry_pick', replayCommit: commit.success ? commit.stdout.trim() : undefined, canContinue: false, canAbort: true };
}

export async function readGitConflictEntries(context: ScmBackendContext): Promise<NonNullable<ScmOperationState['conflicts']>> {
    const result = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['ls-files', '--unmerged', '-z'], timeoutMs: 10_000, env: buildScmNonInteractiveEnv() });
    if (!result.success) throw Object.assign(new Error(result.stderr || 'Failed to inspect unmerged index entries'), { errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED });
    const entries = new Map<string, NonNullable<ScmOperationState['conflicts']>[number]>();
    for (const token of result.stdout.split('\0')) {
        if (!token) continue;
        const match = /^\d+ ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(token);
        if (!match) throw new Error('Invalid unmerged index entry');
        const [, oid, stage, path] = match;
        const entry = entries.get(path) ?? { path, kind: 'unmerged', indexStages: {} };
        entry.indexStages ??= {};
        entry.indexStages[stage === '1' ? 'base' : stage === '2' ? 'ours' : 'theirs'] = oid;
        entries.set(path, entry);
    }
    for (const entry of entries.values()) {
        const stages = entry.indexStages!;
        entry.kind = stages.base ? stages.ours ? stages.theirs ? 'both_modified' : 'deleted_by_them' : stages.theirs ? 'deleted_by_us' : 'both_deleted' : stages.ours && stages.theirs ? 'both_added' : stages.ours ? 'added_by_us' : 'added_by_them';
    }
    return [...entries.values()];
}

export async function readGitOperationRepositoryState(context: ScmBackendContext, snapshot?: { operationState?: ScmOperationState | null; hasConflicts: boolean }): Promise<ScmOperationRepositoryState> {
    if (snapshot) return { headOid: snapshot.operationState?.headOid ?? await readHeadOid(context), hasConflicts: snapshot.hasConflicts, operation: snapshot.operationState ?? null };
    const operation = await readGitBranchOperationState(context);
    const conflicts = operation?.conflicts ?? await readGitConflictEntries(context);
    return { headOid: operation?.headOid ?? await readHeadOid(context), hasConflicts: conflicts.length > 0, operation };
}
