import { realpathSync } from 'node:fs';
import path, { relative, sep } from 'node:path';

import {
    ScmSelectedMutationPathSchema } from '@happier-dev/plugin-sdk/scm';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import {
    resolveBackendCommandMaxOutputBytes as resolveScmBackendCommandMaxOutputBytes,
    runBackendCommand as runScmBackendCommand,
} from '@happier-dev/plugin-sdk/scm/backend';

import { SAPLING_INSTALLABLE_DEP_ID } from './installables/saplingInstallable.js';

export type SaplingExecResult = Readonly<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
}>;

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SAFE_COMMIT_REF_REGEX = /^(?:[0-9a-fA-F]{7,64}|[A-Za-z0-9._/-]+)$/;

function resolveMaxOutputBytes(inputMaxOutputBytes: number | undefined): number {
    return resolveScmBackendCommandMaxOutputBytes({
        inputMaxOutputBytes,
        defaultMaxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    });
}

export function runSaplingCommand(input: Readonly<{
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
}>): Promise<SaplingExecResult> {
    return runScmBackendCommand({
        installableKey: SAPLING_INSTALLABLE_DEP_ID,
        command: 'sl',
    }, {
        cwd: input.cwd,
        args: input.args,
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        maxOutputBytes: resolveMaxOutputBytes(input.maxOutputBytes),
    });
}

export function normalizePathspec(rawPath: string, cwd: string): { ok: true; pathspec: string } | { ok: false; error: string } {
    const selectedPath = ScmSelectedMutationPathSchema.safeParse(rawPath);
    if (!selectedPath.success) {
        return { ok: false, error: 'Path must identify a file or subdirectory' };
    }
    const canonicalCwd = (() => {
        try {
            return realpathSync(path.resolve(cwd));
        } catch {
            return path.resolve(cwd);
        }
    })();
    const resolvedPath = path.resolve(canonicalCwd, rawPath);
    const rel = relative(canonicalCwd, resolvedPath);
    if (rel === '' || rel === '.') {
        return { ok: false, error: 'Path must identify a file or subdirectory' };
    }
    if (!isCanonicalAbsolutePathInsideRoot(canonicalCwd, resolvedPath)) {
        return { ok: false, error: `Path outside working directory: ${rawPath}` };
    }
    if (rel.startsWith('-')) {
        return { ok: false, error: `Invalid path: ${rawPath}` };
    }
    return { ok: true, pathspec: rel.split(sep).join('/') };
}

export function normalizeCommitRef(rawCommit: string): { ok: true; commit: string } | { ok: false; error: string } {
    const commit = rawCommit.trim();
    if (!commit) {
        return { ok: false, error: 'Commit reference cannot be empty' };
    }
    if (/\s/.test(commit)) {
        return { ok: false, error: 'Commit reference must not contain whitespace' };
    }
    if (commit.startsWith('-')) {
        return { ok: false, error: 'Commit reference cannot start with "-"' };
    }
    if (commit.startsWith('.') || commit.startsWith('/')) {
        return { ok: false, error: 'Commit reference contains unsupported syntax' };
    }
    if (commit.includes('..') || commit.includes('@{') || commit.includes(':')) {
        return { ok: false, error: 'Commit reference contains unsupported syntax' };
    }
    if (!SAFE_COMMIT_REF_REGEX.test(commit)) {
        return { ok: false, error: 'Commit reference contains invalid characters' };
    }
    return { ok: true, commit };
}
