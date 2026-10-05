import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ScmOperationRepositoryState, ScmOperationState } from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { runScmCommand } from '../runtime.js';
import type { ScmBackendContext } from '../types.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';

export async function resolveGitStatePath(context: ScmBackendContext, statePath: string): Promise<string | null> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['rev-parse', '--git-path', statePath],
        timeoutMs: 10_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) throw Object.assign(new Error(result.stderr || 'Failed to inspect Git operation state'), { errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED });
    const rawPath = result.stdout.trim();
    if (!rawPath) return null;
    return isAbsolute(rawPath) ? rawPath : resolve(context.cwd, rawPath);
}

async function directoryExists(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function readTrimmedFile(path: string, format: 'trimmed' | 'raw' = 'trimmed'): Promise<string | null> {
    try {
        const content = await readFile(path, 'utf8');
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

async function readMergeOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    const mergeHeadPath = await resolveGitStatePath(context, 'MERGE_HEAD');
    const mergeHead = mergeHeadPath ? await readTrimmedFile(mergeHeadPath) : null;
    if (!mergeHead) {
        return null;
    }

    const mergeMessagePath = await resolveGitStatePath(context, 'MERGE_MSG');
    const sourceRef = (mergeMessagePath ? parseMergeSourceRef(await readTrimmedFile(mergeMessagePath)) : null) ?? mergeHead;
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

async function readRebaseSourceRef(context: ScmBackendContext, rebaseDirName: 'rebase-merge' | 'rebase-apply'): Promise<string | null> {
    const ontoNamePath = await resolveGitStatePath(context, `${rebaseDirName}/onto_name`);
    const ontoName = ontoNamePath ? await readTrimmedFile(ontoNamePath) : null;
    if (ontoName && ontoName !== 'onto') return ontoName.replace(/^refs\/heads\//, '');

    const headNamePath = await resolveGitStatePath(context, `${rebaseDirName}/head-name`);
    const headName = headNamePath ? await readTrimmedFile(headNamePath) : null;
    return headName ? headName.replace(/^refs\/heads\//, '') : null;
}

async function readRebaseOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    for (const rebaseDirName of ['rebase-merge', 'rebase-apply'] as const) {
        const rebasePath = await resolveGitStatePath(context, rebaseDirName);
        if (!rebasePath || !(await directoryExists(rebasePath))) {
            continue;
        }
        return {
            kind: 'rebase',
            sourceRef: await readRebaseSourceRef(context, rebaseDirName),
            replayCommit: await readGitStateFile(context, 'REBASE_HEAD') ?? await readGitStateFile(context, `${rebaseDirName}/stopped-sha`) ?? await readGitStateFile(context, `${rebaseDirName}/original-commit`) ?? undefined,
            baseOid: await readGitStateFile(context, `${rebaseDirName}/onto`) ?? undefined,
            canContinue: false,
            canAbort: true,
        };
    }

    return null;
}

export async function readGitBranchOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    // A rebase directory controls its replay even when another head marker remains.
    const state = (await readRebaseOperationState(context)) ?? (await readMergeOperationState(context)) ?? (await readReplayOperationState(context));
    if (!state) return null;
    const conflicts = await readGitConflictEntries(context);
    return { ...state, headOid: await readHeadOid(context), conflicts, unresolvedCount: conflicts.length, canContinue: conflicts.length === 0, canSkip: state.kind !== 'merge' && Boolean(state.replayCommit) };
}

export async function readGitStateFile(context: ScmBackendContext, name: string, format: 'trimmed' | 'raw' = 'trimmed') {
    const path = await resolveGitStatePath(context, name);
    return path ? readTrimmedFile(path, format) : null;
}

async function readHeadOid(context: ScmBackendContext) {
    const result = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', 'HEAD'], timeoutMs: 10_000, env: buildScmNonInteractiveEnv() });
    return result.success ? result.stdout.trim() || undefined : undefined;
}

async function readReplayOperationState(context: ScmBackendContext): Promise<ScmOperationState | null> {
    const revertHead = await readGitStateFile(context, 'REVERT_HEAD');
    const pickHead = revertHead ? null : await readGitStateFile(context, 'CHERRY_PICK_HEAD');
    if (revertHead || pickHead) return { kind: revertHead ? 'revert' : 'cherry_pick', replayCommit: revertHead ?? pickHead ?? undefined, canContinue: false, canAbort: true };
    const todo = await readGitStateFile(context, 'sequencer/todo');
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
