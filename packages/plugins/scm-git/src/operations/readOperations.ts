import type {
  ScmDiffCommitRequest,
  ScmDiffCommitResponse,
  ScmDiffFileRequest,
  ScmDiffFileResponse,
  ScmLogEntry,
  ScmLogListRequest,
  ScmLogListResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';
import { parseGitComparisonOutput } from '@happier-dev/cli-common/scm/gitComparisonOutput';
import type { ScmBackendContext } from '../types.js';
import { normalizeCommitRef, normalizeRepoRootRelativePath, runScmCommand } from '../runtime.js';

const GIT_LOG_FIELDS_PER_ENTRY = 7;

/** Git's --author matcher is a basic regular expression, unlike --grep -F. Escape
 * the basic-regex metacharacters so user input is interpreted literally. */
function escapeGitAuthorPattern(value: string): string {
    return value.replace(/[\\.^$*\[\]]/g, '\\$&');
}

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
            // `--pretty=format:` uses record-SEPARATOR semantics: git emits `\n` between
            // records, which lands at the start of every sha field after the first. Trim the
            // hex field so commit identity is exact for entries 2+ (dedupe, pagination,
            // activation) instead of only for the newest entry.
            sha: (row[0] || '').trim(),
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
    const normalized = normalizeRepoRootRelativePath(request.path);
    if (!normalized.ok) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: normalized.error,
        };
    }
    const area = request.area ?? 'pending';
    const args =
        area === 'included'
            ? ['diff', '--no-ext-diff', '--cached', '--', normalized.pathspec]
            : area === 'both'
                ? ['diff', '--no-ext-diff', 'HEAD', '--', normalized.pathspec]
                : ['diff', '--no-ext-diff', '--', normalized.pathspec];
    let result = await runScmCommand({ bin: 'git', cwd: context.cwd, args, timeoutMs: 10_000 });
    if (area === 'both' && !result.success && result.exitCode !== 1 && !result.timedOut && !result.outputLimitExceeded) {
        const head = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], timeoutMs: 10_000 });
        if (!head.success && head.exitCode === 1 && !head.timedOut && !head.outputLimitExceeded) {
            // An unborn checkout has no HEAD. Git accepts its format-specific empty tree
            // as a diff base without writing an object or changing the index.
            const emptyTree = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['hash-object', '-t', 'tree', '--stdin'], stdin: '', timeoutMs: 10_000 });
            if (!emptyTree.success) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: emptyTree.stderr || 'Failed to resolve empty tree' };
            }
            result = await runScmCommand({ bin: 'git', cwd: context.cwd, args: ['diff', '--no-ext-diff', emptyTree.stdout.trim(), '--', normalized.pathspec], timeoutMs: 10_000 });
        }
    }
    // git diff uses exit code 1 to indicate "differences found". Treat that as success so
    // callers can still render patches.
    const diffCommandOk =
        result.success || (result.exitCode === 1 && !result.timedOut && !result.outputLimitExceeded);
    if (!diffCommandOk) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load file diff',
        };
    }

    const diff = result.stdout ?? '';
    if (diff.trim().length > 0 || area === 'included') {
        return { success: true, diff };
    }

    const repoRoot = context.detection.rootPath ?? context.cwd;
    const relativePath = normalized.relativePath;
    if (!repoRoot || !relativePath || relativePath === '.') {
        return { success: true, diff };
    }

    // git diff does not report untracked file diffs. Detect untracked files and synthesize
    // an add diff against /dev/null so UI can show a meaningful patch.
    const untrackedCheck = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['ls-files', '--others', '--exclude-standard', '-z', '--', normalized.pathspec],
        timeoutMs: 10_000,
    });
    if (!untrackedCheck.success) {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: untrackedCheck.stderr || 'Failed to inspect untracked file' };
    }
    const isUntracked =
        typeof untrackedCheck.stdout === 'string'
        && untrackedCheck.stdout.split('\0').includes(relativePath);

    if (!isUntracked) {
        return { success: true, diff };
    }

    const untrackedDiff = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['diff', '--no-ext-diff', '--no-index', '--', '/dev/null', relativePath],
        timeoutMs: 10_000,
    });
    const untrackedDiffOk =
        untrackedDiff.success || (untrackedDiff.exitCode === 1 && !untrackedDiff.timedOut && !untrackedDiff.outputLimitExceeded);
    return untrackedDiffOk
        ? { success: true, diff: untrackedDiff.stdout }
        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: untrackedDiff.stderr || 'Failed to load untracked file diff' };
}

export async function gitDiffCommit(input: {
    context: ScmBackendContext;
    request: ScmDiffCommitRequest;
}): Promise<ScmDiffCommitResponse> {
    const { context, request } = input;
    if (request.beforeTreeOid !== undefined) {
        const trees = [request.beforeTreeOid, request.commit];
        if (trees.some((tree) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Tree comparison requires immutable tree OIDs' };
        }
        const types = await Promise.all(trees.map((tree) => runScmCommand({ bin: 'git', cwd: context.cwd,
            args: ['cat-file', '-t', tree], timeoutMs: 15_000 })));
        for (const type of types) {
            if (!type.success || type.stdout.trim() !== 'tree') {
                return { success: false,
                    errorCode: type.timedOut || type.outputLimitExceeded ? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED : SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                    error: type.stderr || 'Recorded tree comparison endpoint is unavailable or is not a tree' };
            }
        }
        const result = await runScmCommand({ bin: 'git', cwd: context.cwd,
            args: ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--raw', '--no-abbrev', '-z',
                '--patch', '--binary', '--full-index', request.beforeTreeOid, request.commit, '--'], timeoutMs: 15_000 });
        if (!result.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Failed to load recorded tree comparison' };
        const parsed = parseGitComparisonOutput(result.stdout);
        if (parsed.error || parsed.sections.length !== parsed.files.length) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                error: parsed.error || 'Git comparison file evidence could not be paired with its inventory' };
        }
        return { success: true, beforeTreeOid: request.beforeTreeOid, afterTreeOid: request.commit,
            diff: parsed.sections.join(''), files: parsed.files.map((file, index) => ({ path: file.path,
                ...(file.previousPath ? { previousPath: file.previousPath } : {}), changeKind: file.changeKind,
                unifiedDiff: parsed.sections[index]! })) };
    }
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

/**
 * A query that only names hexadecimal characters in this range is treated as an abbreviated
 * SHA on top of the text/author arms. Anything else (spaces, `-`, `:`, …) can only be a text
 * match and must never reach git as a revision argument.
 */
const GIT_SHA_LIKE_QUERY_PATTERN = /^[0-9a-f]{7,64}$/i;

function isGitUnknownRevisionFailure(stderr: string | undefined): boolean {
    const lower = String(stderr ?? '').toLowerCase();
    return lower.includes('unknown revision')
        || lower.includes('ambiguous argument')
        || lower.includes('not a valid object name')
        || lower.includes('not a valid commit name')
        || lower.includes('bad object');
}

type GitLogMatchArm =
    | { ok: true; entries: ScmLogEntry[] }
    | { ok: false; unknownRevision: true }
    | { ok: false; stderr: string };

async function runGitLogMatchArm(input: {
    cwd: string;
    args: string[];
    signal?: AbortSignal;
}): Promise<GitLogMatchArm> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['log', ...input.args, '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00'],
        timeoutMs: 15_000,
        signal: input.signal,
    });
    if (!result.success) {
        return isGitUnknownRevisionFailure(result.stderr)
            ? { ok: false, unknownRevision: true }
            : { ok: false, stderr: result.stderr || 'Failed to search commits' };
    }
    return { ok: true, entries: parseGitLogEntries(result.stdout) };
}

async function runGitShaLogMatchArm(input: {
    cwd: string;
    query: string;
    signal?: AbortSignal;
}): Promise<GitLogMatchArm> {
    const ancestry = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['merge-base', '--is-ancestor', input.query, 'HEAD'],
        timeoutMs: 15_000,
        signal: input.signal,
    });
    if (!ancestry.success) {
        if (ancestry.exitCode === 1 || isGitUnknownRevisionFailure(ancestry.stderr)) {
            return { ok: false, unknownRevision: true };
        }
        return { ok: false, stderr: ancestry.stderr || 'Failed to verify commit ancestry' };
    }
    return runGitLogMatchArm({
        cwd: input.cwd,
        args: ['--max-count=1', input.query],
        signal: input.signal,
    });
}

function mergeGitLogMatchArms(arms: readonly GitLogMatchArm[]): ScmLogEntry[] {
    const bySha = new Map<string, ScmLogEntry>();
    for (const arm of arms) {
        if (!arm.ok) continue;
        for (const entry of arm.entries) {
            if (!bySha.has(entry.sha)) {
                bySha.set(entry.sha, entry);
            }
        }
    }
    return [...bySha.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export async function gitLogList(input: {
    context: ScmBackendContext;
    request: ScmLogListRequest;
    signal?: AbortSignal;
}): Promise<ScmLogListResponse> {
    const { context, request } = input;
    const limit = request.limit ?? 50;
    const skip = request.skip ?? 0;
    const query = typeof request.query === 'string' ? request.query.trim() : '';

    if (request.range === 'incoming') {
        if (query) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Incoming log cannot be searched' };
        }
        const incoming = await runScmCommand({
            bin: 'git', cwd: context.cwd,
            args: [
                'log', `--max-count=${limit}`, `--skip=${skip}`,
                '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00',
                'HEAD..@{upstream}',
            ],
            timeoutMs: 15_000,
            signal: input.signal,
        });
        return incoming.success
            ? { success: true, entries: parseGitLogEntries(incoming.stdout), rangeApplied: true }
            : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: incoming.stderr || 'Failed to list incoming commits' };
    }

    if (!query) {
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
            signal: input.signal,
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

    // Bounded search over the explicit workspace scope (`context.cwd`, the checkout the
    // request addresses). Every arm reads at most `limit + skip` commits off the current
    // checkout; the merged page is sliced once. There is no all-history walk and no all-ref
    // (`--all`) fanout — the ref scope stays the checkout's current branch.
    const readBound = limit + skip;
    const arms: Array<Promise<GitLogMatchArm>> = [
        // Commit subject and body text (`--grep` inspects the whole message). Fixed strings
        // keep the user's query from acting as a regular expression.
        runGitLogMatchArm({
            cwd: context.cwd,
            args: ['-i', '-F', `--grep=${query}`, `--max-count=${readBound}`],
            signal: input.signal,
        }),
        // Author name and email (git matches `Name <email>` as one string).
        runGitLogMatchArm({
            cwd: context.cwd,
            args: ['-i', `--author=${escapeGitAuthorPattern(query)}`, `--max-count=${readBound}`],
            signal: input.signal,
        }),
    ];
    if (GIT_SHA_LIKE_QUERY_PATTERN.test(query)) {
        // Resolve the SHA only after proving it belongs to the current checkout's HEAD
        // ancestry. A bare revision argument would also admit commits reachable solely from
        // another local branch, contradicting this operation's current-branch scope.
        arms.push(runGitShaLogMatchArm({ cwd: context.cwd, query, signal: input.signal }));
    }

    const settledArms = await Promise.all(arms);

    const failedArm = settledArms.find((arm): arm is Extract<GitLogMatchArm, { ok: false; stderr: string }> => !arm.ok && !('unknownRevision' in arm));
    if (failedArm) {
        // The text and author arms read the same repository; one hard failure means the
        // repository itself cannot answer (the unknown-revision case is filtered out above).
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: failedArm.stderr,
        };
    }

    return {
        success: true,
        entries: mergeGitLogMatchArms(settledArms).slice(skip, skip + limit),
        queryApplied: true,
    };
}
