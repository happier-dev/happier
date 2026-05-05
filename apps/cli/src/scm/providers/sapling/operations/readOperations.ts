import type {
    ScmDiffCommitRequest,
    ScmDiffCommitResponse,
    ScmDiffFileRequest,
    ScmDiffFileResponse,
    ScmLogEntry,
    ScmLogListRequest,
    ScmLogListResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import type { ScmBackendContext } from '../../../types';
import { normalizeCommitRef, normalizePathspec, runScmCommand } from '../../../runtime';

function parseLogTimestamp(hgDateValue: string): number {
    const seconds = Number((hgDateValue || '').split(' ')[0] || 0);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

function parseSaplingLogEntries(rawOutput: string): ScmLogEntry[] {
    const fields = rawOutput.split('\0');
    const entries: ScmLogEntry[] = [];

    for (let i = 0; i + 6 < fields.length; i += 7) {
        const sha = fields[i] || '';
        if (!sha) continue;
        entries.push({
            sha,
            shortSha: fields[i + 1] || sha.slice(0, 12),
            authorName: fields[i + 2] || '',
            authorEmail: fields[i + 3] || '',
            timestamp: parseLogTimestamp(fields[i + 4] || ''),
            subject: fields[i + 5] || '',
            body: fields[i + 6] || '',
        });
    }

    return entries;
}

export async function saplingDiffFile(input: {
    context: ScmBackendContext;
    request: ScmDiffFileRequest;
}): Promise<ScmDiffFileResponse> {
    const { context, request } = input;
    const pathspec = normalizePathspec(request.path, context.cwd);
    if (!pathspec.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: pathspec.error,
        };
    }
    if (request.area === 'included') {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            error: 'Sapling does not support include-only diff area in this backend',
        };
    }
    const result = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: ['diff', '-g', '--', pathspec.pathspec],
        timeoutMs: 10_000,
    });
    return result.success
        ? { success: true, diff: result.stdout }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load file diff',
        };
}

export async function saplingDiffCommit(input: {
    context: ScmBackendContext;
    request: ScmDiffCommitRequest;
}): Promise<ScmDiffCommitResponse> {
    const { context, request } = input;
    const commitRef = normalizeCommitRef(request.commit);
    if (!commitRef.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            error: commitRef.error,
        };
    }
    const result = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: ['show', '-g', commitRef.commit],
        timeoutMs: 15_000,
    });
    return result.success
        ? { success: true, diff: result.stdout }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load commit diff',
        };
}

export async function saplingLogList(input: {
    context: ScmBackendContext;
    request: ScmLogListRequest;
}): Promise<ScmLogListResponse> {
    const { context, request } = input;
    const limit = request.limit ?? 50;
    const skip = request.skip ?? 0;
    const readCount = limit + skip;
    const log = await runScmCommand({
        bin: 'sl',
        cwd: context.cwd,
        args: [
            'log',
            '--limit',
            String(readCount),
            '--template',
            '{node}\\0{node|short}\\0{author|person}\\0{author|email}\\0{date|hgdate}\\0{desc|firstline}\\0{desc}\\0',
        ],
        timeoutMs: 15_000,
    });
    if (!log.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: log.stderr || 'Failed to list commits',
        };
    }

    const entries = parseSaplingLogEntries(log.stdout).slice(skip, skip + limit);
    return {
        success: true,
        entries,
    };
}
