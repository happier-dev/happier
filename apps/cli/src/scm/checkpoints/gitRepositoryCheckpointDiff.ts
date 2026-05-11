import type { FileChangeKind } from '@happier-dev/protocol';

import { resolveRepositoryCheckpointAvailability } from './availability';
import { classifyGitCheckpointCommandFailure, runGitCheckpointCommand } from './gitCheckpointCommands';
import { buildRepositoryCheckpointRef } from './refs';
import { REPOSITORY_CHECKPOINT_RECEIPT_IDS } from './receipts';
import type {
    RepositoryCheckpointDiffRequest,
    RepositoryCheckpointDiffResult,
    RepositoryCheckpointRef,
} from './types';

type ParsedNameStatusEntry = Readonly<{
    status: string;
    filePath: string;
    previousFilePath?: string | null;
}>;

function validateDiffRef(checkpointRef: RepositoryCheckpointRef): string | null {
    let expected: RepositoryCheckpointRef;
    try {
        expected = buildRepositoryCheckpointRef({
            scopeId: checkpointRef.scopeId,
            phase: checkpointRef.phase,
            checkpointId: checkpointRef.checkpointId,
        });
    } catch {
        return 'Checkpoint diff ref is malformed or outside the Happier checkpoint namespace.';
    }
    return checkpointRef.encodedScope !== expected.encodedScope || checkpointRef.ref !== expected.ref
        ? 'Checkpoint diff ref is outside the Happier checkpoint namespace.'
        : null;
}

function normalizePath(path: string): string {
    return path.replace(/\\/g, '/');
}

function parseNameStatus(stdout: string): ParsedNameStatusEntry[] {
    const tokens = stdout.split('\0').filter((token) => token.length > 0);
    const entries: ParsedNameStatusEntry[] = [];
    for (let index = 0; index < tokens.length;) {
        const status = tokens[index] ?? '';
        index += 1;
        if (status.startsWith('R') || status.startsWith('C')) {
            const previousFilePath = tokens[index] ?? '';
            const filePath = tokens[index + 1] ?? '';
            index += 2;
            if (filePath) {
                entries.push({ status, filePath: normalizePath(filePath), previousFilePath: normalizePath(previousFilePath) });
            }
            continue;
        }
        const filePath = tokens[index] ?? '';
        index += 1;
        if (filePath) entries.push({ status, filePath: normalizePath(filePath) });
    }
    return entries;
}

function changeKindFromStatus(status: string): FileChangeKind {
    const code = status[0];
    if (code === 'A') return 'added';
    if (code === 'D') return 'deleted';
    if (code === 'R') return 'renamed';
    if (code === 'C') return 'copied';
    if (code === 'M' || code === 'T') return 'modified';
    return 'unknown';
}

async function refExists(cwd: string, ref: RepositoryCheckpointRef): Promise<boolean> {
    const result = await runGitCheckpointCommand({
        cwd,
        args: ['rev-parse', '--verify', `${ref.ref}^{commit}`],
        timeoutMs: 5000,
    });
    return result.success && result.stdout.trim().length > 0;
}

async function readUnifiedDiff(input: Readonly<{
    cwd: string;
    baseRef: RepositoryCheckpointRef;
    finalRef: RepositoryCheckpointRef;
    filePath: string;
    previousFilePath?: string | null;
}>): Promise<{ unifiedDiff?: string; binary: boolean }> {
    const pathspecs = input.previousFilePath && input.previousFilePath !== input.filePath
        ? [input.previousFilePath, input.filePath]
        : [input.filePath];
    const result = await runGitCheckpointCommand({
        cwd: input.cwd,
        args: ['diff', '--find-renames', '--binary', input.baseRef.ref, input.finalRef.ref, '--', ...pathspecs],
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024,
    });
    if (!result.success) return { binary: false };
    const unifiedDiff = result.stdout.trim().length > 0 ? result.stdout : undefined;
    return {
        unifiedDiff,
        binary: /GIT binary patch|Binary files .* differ/i.test(result.stdout),
    };
}

export async function diffGitRepositoryCheckpoints(
    input: RepositoryCheckpointDiffRequest,
): Promise<RepositoryCheckpointDiffResult> {
    const baseRefError = validateDiffRef(input.baseRef);
    const finalRefError = validateDiffRef(input.finalRef);
    if (baseRefError || finalRefError || input.baseRef.scopeId !== input.finalRef.scopeId) {
        return {
            success: false,
            kind: 'failed',
            reason: 'invalid_ref',
            error: baseRefError ?? finalRefError ?? 'Checkpoint diff refs must share the same scope.',
            baseRefSource: input.baseRefSource,
            contentConfidence: 'unavailable',
            attributionScope: input.attributionScope,
            receipts: [],
        };
    }

    const availability = resolveRepositoryCheckpointAvailability({ context: input.context });
    if (!availability.available) {
        return {
            success: false,
            kind: 'unavailable',
            reason: availability.reason,
            error: availability.message,
            baseRefSource: input.baseRefSource,
            contentConfidence: 'unavailable',
            attributionScope: input.attributionScope,
            receipts: [],
        };
    }

    if (!await refExists(availability.repoRoot, input.baseRef)) {
        return {
            success: false,
            kind: 'unavailable',
            reason: 'missing_base',
            error: 'Checkpoint diff base ref is unavailable.',
            baseRefSource: input.baseRefSource,
            contentConfidence: 'unavailable',
            attributionScope: input.attributionScope,
            receipts: [],
        };
    }
    if (!await refExists(availability.repoRoot, input.finalRef)) {
        return {
            success: false,
            kind: 'unavailable',
            reason: 'missing_final',
            error: 'Checkpoint diff final ref is unavailable.',
            baseRefSource: input.baseRefSource,
            contentConfidence: 'unavailable',
            attributionScope: input.attributionScope,
            receipts: [],
        };
    }

    const nameStatus = await runGitCheckpointCommand({
        cwd: availability.repoRoot,
        args: ['diff', '--name-status', '-z', '--find-renames', '--find-copies', input.baseRef.ref, input.finalRef.ref],
        timeoutMs: 10_000,
    });
    if (!nameStatus.success) {
        const failure = classifyGitCheckpointCommandFailure(nameStatus, 'Failed to compute checkpoint diff');
        return {
            success: false,
            kind: 'unavailable',
            reason: failure.reason,
            error: failure.error,
            baseRefSource: input.baseRefSource,
            contentConfidence: 'unavailable',
            attributionScope: input.attributionScope,
            receipts: [],
        };
    }

    const files = await Promise.all(parseNameStatus(nameStatus.stdout).map(async (entry) => {
        const diff = await readUnifiedDiff({
            cwd: availability.repoRoot,
            baseRef: input.baseRef,
            finalRef: input.finalRef,
            filePath: entry.filePath,
            previousFilePath: entry.previousFilePath,
        });
        return {
            filePath: entry.filePath,
            previousFilePath: entry.previousFilePath ?? null,
            changeKind: changeKindFromStatus(entry.status),
            ...(diff.unifiedDiff ? { unifiedDiff: diff.unifiedDiff } : {}),
            ...(diff.binary ? { binary: true } : {}),
            source: 'scm_checkpoint' as const,
            confidence: 'exact' as const,
            provider: 'scm:git',
        };
    }));

    return {
        success: true,
        baseRef: input.baseRef,
        finalRef: input.finalRef,
        baseRefSource: input.baseRefSource,
        contentConfidence: 'exact',
        attributionScope: input.attributionScope,
        files,
        receipts: [{
            id: REPOSITORY_CHECKPOINT_RECEIPT_IDS.diffComputed,
            ref: input.finalRef.ref,
        }],
    };
}
