import { realpathSync } from 'node:fs';
import path, { isAbsolute, relative, sep } from 'node:path';

import { readCurrentScmBackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';

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
    if (typeof inputMaxOutputBytes === 'number' && Number.isFinite(inputMaxOutputBytes) && inputMaxOutputBytes > 0) {
        return Math.floor(inputMaxOutputBytes);
    }
    return DEFAULT_MAX_OUTPUT_BYTES;
}

export function runSaplingCommand(input: Readonly<{
    cwd: string;
    args: readonly string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
}>): Promise<SaplingExecResult> {
    const runtimeServices = readCurrentScmBackendRuntimeServices();
    if (!runtimeServices) {
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: 'SCM command runner is unavailable for sl',
            exitCode: -1,
        });
    }

    return runtimeServices.runCommand({
        installableKey: 'dep.sapling',
        command: 'sl',
        cwd: input.cwd,
        args: input.args,
        timeoutMs: input.timeoutMs,
        stdin: input.stdin,
        maxOutputBytes: resolveMaxOutputBytes(input.maxOutputBytes),
    });
}

export function normalizePathspec(rawPath: string, cwd: string): { ok: true; pathspec: string } | { ok: false; error: string } {
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
        return { ok: true, pathspec: '.' };
    }
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { ok: false, error: `Path outside working directory: ${rawPath}` };
    }
    if (rel.includes('\0') || rel.startsWith('-')) {
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
