import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import type { WorkspaceIntegrationHandlers } from '@happier-dev/plugin-sdk/scm/backend';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { getScmCommandIndeterminateErrorCode, runScmCommand } from '../runtime.js';
import { gitFileAtRevision } from './fileAtRevision.js';
import { fetchVerifiedGitCommitRef } from './materializeGitWorkspaceCheckout.js';

const refuse = (code: string) => Object.assign(new Error(code), { code });

export const fetchGitCommitRef: NonNullable<WorkspaceIntegrationHandlers['fetchCommitRef']> = async input => {
    const cwd = input.context.detection.rootPath ?? input.context.cwd;
    input.context.assertFilesystemPathAuthorized?.(cwd);
    try {
        await fetchVerifiedGitCommitRef({ repoRoot: cwd, cloneUrl: input.cloneUrl, ref: input.ref,
            expectedCommitSha: input.expectedCommitSha, signal: input.signal });
    } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof Error && !('code' in error)) {
            throw Object.assign(error, { code: 'errorCode' in error ? error.errorCode : 'git_selection_unavailable' });
        }
        throw error;
    }
};

export const resolveGitCommitRef: NonNullable<WorkspaceIntegrationHandlers['resolveCommitRef']> = async input => {
    input.signal?.throwIfAborted();
    if (!input.ref.trim() || input.ref.includes('\0')) throw refuse('git_selection_unavailable');
    const cwd = input.context.detection.rootPath ?? input.context.cwd;
    input.context.assertFilesystemPathAuthorized?.(cwd);
    const result = await runScmCommand({ bin: 'git', cwd,
        args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${input.ref}^{commit}`], signal: input.signal });
    input.signal?.throwIfAborted();
    const sha = result.stdout.trim();
    if (!result.success || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
        const indeterminate = getScmCommandIndeterminateErrorCode(result);
        // Peeling also fails for an existing ref whose object is missing. Only a
        // missing unpeeled name permits fallback; corruption keeps the local refusal.
        if (!indeterminate && !result.success && result.exitCode === 1 && !sha && !result.stderr.trim()) {
            const unpeeled = await runScmCommand({ bin: 'git', cwd,
                args: ['rev-parse', '--verify', '--quiet', '--end-of-options', input.ref], signal: input.signal });
            input.signal?.throwIfAborted();
            const unpeeledIndeterminate = getScmCommandIndeterminateErrorCode(unpeeled);
            if (!unpeeledIndeterminate && !unpeeled.success && unpeeled.exitCode === 1
                && !unpeeled.stdout.trim() && !unpeeled.stderr.trim()) throw refuse(SCM_OPERATION_ERROR_CODES.NOT_FOUND);
            throw refuse(unpeeledIndeterminate ?? 'git_selection_unavailable');
        }
        throw refuse(indeterminate ?? 'git_selection_unavailable');
    }
    return sha;
};

/** Export object-database bytes through the existing entries/blob materializer. */
export const exportGitCommit: NonNullable<WorkspaceIntegrationHandlers['exportCommit']> = async input => {
    input.signal?.throwIfAborted();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.commitSha)) throw refuse('git_selection_unavailable');
    const cwd = input.context.detection.rootPath ?? input.context.cwd;
    input.context.assertFilesystemPathAuthorized?.(cwd);
    // Export the admitted objects themselves, never a local refs/replace view.
    const type = await runScmCommand({ bin: 'git', cwd, args: ['--no-replace-objects', 'cat-file', '-t', input.commitSha], signal: input.signal });
    input.signal?.throwIfAborted();
    if (!type.success || type.stdout.trim() !== 'commit') {
        throw refuse(getScmCommandIndeterminateErrorCode(type) ?? 'git_selection_unavailable');
    }

    const summary = await runScmCommand({ bin: 'git', cwd,
        args: ['--no-replace-objects', 'show', '-s', '--format=%s', input.commitSha, '--'], signal: input.signal });
    input.signal?.throwIfAborted();

    const rows: Array<{ mode: string; objectId: string; path: string }> = [];
    let pending = '';
    let listingFailure: unknown;
    // A filename which cannot round-trip as UTF-8 must refuse rather than name another file.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const tree = await runScmCommand({ bin: 'git', cwd, args: ['--no-replace-objects', 'ls-tree', '-r', '-z', '--full-tree', input.commitSha], signal: input.signal,
        stdoutConsumer(chunk) {
            try {
                pending += decoder.decode(chunk, { stream: true });
                let end: number;
                while ((end = pending.indexOf('\0')) >= 0) {
                    const line = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(line);
                    if (!match || match[2] !== 'blob' || !['100644', '100755', '120000'].includes(match[1])) throw refuse('unsupported');
                    rows.push({ mode: match[1], objectId: match[3], path: match[4] });
                }
                return 'continue';
            } catch (error) {
                // The host stream runner owns process cleanup and reports consumer
                // failures as command results; retain this leaf's typed refusal.
                listingFailure = error;
                return 'stop';
            }
        },
    });
    input.signal?.throwIfAborted();
    if (listingFailure) throw listingFailure;
    if (!tree.success || pending || decoder.decode()) {
        throw refuse(getScmCommandIndeterminateErrorCode(tree) ?? 'git_selection_unavailable');
    }

    await mkdir(input.artifactDirectory, { recursive: true });
    const root = await mkdtemp(join(input.artifactDirectory, 'happier-commit-'));
    const dispose = async () => { await rm(root, { recursive: true, force: true }); };
    try {
        const entries: Array<{ relativePath: string; sourcePath: string }> = [];
        for (const row of rows) {
            input.signal?.throwIfAborted();
            const blob = await gitFileAtRevision({ context: input.context, request: { path: row.path, selector: { blobId: row.objectId } }, signal: input.signal });
            input.signal?.throwIfAborted();
            if (!blob.success) throw refuse(blob.errorCode);
            const bytes = Buffer.from(blob.contentBase64, 'base64');
            // Scratch names never inherit repository path or link traversal semantics.
            const sourcePath = join(root, String(entries.length));
            if (row.mode === '120000') await symlink(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), sourcePath);
            else {
                await writeFile(sourcePath, bytes, { mode: row.mode === '100755' ? 0o700 : 0o600 });
                if (row.mode === '100755') await chmod(sourcePath, 0o700);
            }
            entries.push({ relativePath: row.path, sourcePath });
        }
        input.signal?.throwIfAborted();
        return { commitSha: input.commitSha, ...(summary.success ? { commitSubject: summary.stdout.trimEnd() } : {}), entries, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
};
