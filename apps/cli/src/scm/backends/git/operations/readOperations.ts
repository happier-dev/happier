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

const GIT_LOG_FIELDS_PER_ENTRY = 7;

function parseGitLogEntries(rawOutput: string): ScmLogEntry[] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let fieldStart = 0;

    for (let index = 0; index < rawOutput.length; index += 1) {
        if (rawOutput.charCodeAt(index) !== 0) {
            continue;
        }

        currentRow.push(rawOutput.slice(fieldStart, index));
        fieldStart = index + 1;

        if (currentRow.length === GIT_LOG_FIELDS_PER_ENTRY) {
            rows.push(currentRow);
            currentRow = [];
        }
    }

    return rows.map((row) => {
        const timestampSeconds = Number(row[4] || 0);
        const timestampRaw = Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : 0;
        return {
            sha: row[0] || '',
            shortSha: row[1] || '',
            authorName: row[2] || '',
            authorEmail: row[3] || '',
            timestamp: Number.isFinite(timestampRaw) ? timestampRaw : 0,
            subject: row[5] || '',
            body: row[6] || '',
        };
    });
}

export async function gitDiffFile(input: {
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
    const area = request.area ?? 'pending';
    const args =
        area === 'included'
            ? ['diff', '--no-ext-diff', '--cached', '--', pathspec.pathspec]
            : area === 'both'
                ? ['diff', '--no-ext-diff', 'HEAD', '--', pathspec.pathspec]
                : ['diff', '--no-ext-diff', '--', pathspec.pathspec];
    const result = await runScmCommand({ bin: 'git', cwd: context.cwd, args, timeoutMs: 10_000 });
    return result.success
        ? { success: true, diff: result.stdout }
        : {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load file diff',
        };
}

export async function gitDiffCommit(input: {
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
        bin: 'git',
        cwd: context.cwd,
        args: ['show', '--no-ext-diff', '--patch', '--format=fuller', commitRef.commit],
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

export async function gitLogList(input: {
    context: ScmBackendContext;
    request: ScmLogListRequest;
}): Promise<ScmLogListResponse> {
    const { context, request } = input;
    const limit = request.limit ?? 50;
    const skip = request.skip ?? 0;
    const log = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: [
            'log',
            `--max-count=${limit}`,
            `--skip=${skip}`,
            '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00',
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
    return { success: true, entries: parseGitLogEntries(log.stdout) };
}
