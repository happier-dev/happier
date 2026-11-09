import type {
  ScmDiffCommitRequest,
  ScmDiffCommitResponse,
  ScmDiffFileRequest,
  ScmDiffFileResponse,
  ScmBlameFileRequest,
  ScmBlameFileResponse,
  ScmBlameRange,
  ScmBlameCommit,
  ScmLogEntry,
  ScmLogListRequest,
  ScmLogListResponse,
  ScmEntryHistoryV1,
  ScmHistoryEntriesRequest,
  ScmHistoryEntriesResponse,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES, ScmHistoryEntriesInputV1Schema, ScmHistoryEntriesResponseSchema, ScmRevisionRangeV1Schema } from '@happier-dev/plugin-sdk/scm';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';
import { parseGitComparisonOutput } from '@happier-dev/plugin-sdk/scm';
import type { ScmBackendContext } from '../types.js';
import { normalizeCommitRef, normalizeRepoRootRelativePath, runScmCommand } from '../runtime.js';
import { toRepoRootLiteralPathspec } from '../literalPathspec.js';
import { ScmBlameFileRequestSchema, ScmBlameFileResponseSchema } from '@happier-dev/plugin-sdk/scm';

/** Git's incremental grammar (git-blame 2.43+): filename closes each range;
 * author metadata is emitted only on the first occurrence of each commit.
 * The command service admits bytes; this reader never retains complete stdout.
 */
function createGitBlameReader() {
    const decoder = new StringDecoder('utf8');
    const commits: ScmBlameCommit[] = [];
    const indices = new Map<string, number>();
    const ranges: ScmBlameRange[] = [];
    let pending = '';
    let record: { sha: string; startLine: number; lineCount: number; authorName?: string; authorEmail?: string; authoredAtMs?: number; summary?: string } | null = null;
    const line = (text: string) => {
        if (!record) {
            const header = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-9]+) ([0-9]+) ([0-9]+)$/.exec(text);
            if (!header) throw new Error('Invalid incremental blame header');
            record = { sha: header[1], startLine: Number(header[3]), lineCount: Number(header[4]) };
            return;
        }
        if (text.startsWith('author ')) record.authorName = text.slice(7);
        else if (text.startsWith('author-mail ')) record.authorEmail = text.slice(12).replace(/^<|>$/g, '');
        else if (text.startsWith('author-time ')) record.authoredAtMs = Number(text.slice(12)) * 1000;
        else if (text.startsWith('summary ')) record.summary = text.slice(8);
        else if (text.startsWith('filename ')) {
            let commitIndex: number | null = null;
            if (!/^0+$/.test(record.sha)) {
                const known = indices.get(record.sha);
                if (known !== undefined) commitIndex = known;
                else {
                    if (record.authorName === undefined || record.summary === undefined || record.authoredAtMs === undefined
                        || !Number.isSafeInteger(record.authoredAtMs)) throw new Error('Incomplete incremental blame commit');
                    commitIndex = commits.length;
                    indices.set(record.sha, commitIndex);
                    commits.push({ sha: record.sha, shortSha: record.sha.slice(0, 7), authorName: record.authorName,
                        ...(record.authorEmail ? { authorEmail: record.authorEmail } : {}), authoredAtMs: record.authoredAtMs, summary: record.summary });
                }
            }
            ranges.push({ startLine: record.startLine, lineCount: record.lineCount, commitIndex });
            record = null;
        }
        // Other metadata (boundary, previous, committer, timezone) is extensible
        // Git metadata and has no bearing on the author/range projection.
    };
    return {
        consume(chunk: Uint8Array): 'continue' {
            pending += decoder.write(Buffer.from(chunk));
            let start = 0;
            let end: number;
            while ((end = pending.indexOf('\n', start)) >= 0) {
                line(pending.slice(start, end));
                start = end + 1;
            }
            pending = pending.slice(start);
            return 'continue';
        },
        finish() {
            if (decoder.end() !== '' || pending !== '' || record) throw new Error('Unterminated incremental blame record');
            ranges.sort((a, b) => a.startLine - b.startLine);
            const merged: ScmBlameRange[] = [];
            for (const range of ranges) {
                const previous = merged.at(-1);
                if (previous && previous.commitIndex === range.commitIndex && previous.startLine + previous.lineCount === range.startLine) previous.lineCount += range.lineCount;
                else merged.push({ ...range });
            }
            return ScmBlameFileResponseSchema.parse({ success: true, ranges: merged, commits });
        },
    };
}

export async function gitBlameFile(input: {
    context: ScmBackendContext;
    request: ScmBlameFileRequest;
    signal?: AbortSignal;
}): Promise<ScmBlameFileResponse> {
    const parsed = ScmBlameFileRequestSchema.safeParse(input.request);
    if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid blame request' };
    const { context } = input;
    const request = parsed.data;
    const normalized = normalizeRepoRootRelativePath(request.path);
    if (!normalized.ok) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: normalized.error };
    const cwd = context.detection.rootPath ?? context.cwd;
    const signal = input.signal;
    try {
        const root = await realpath(cwd);
        const file = resolve(root, normalized.relativePath);
        if (!isCanonicalAbsolutePathInsideRoot(root, await realpath(file))) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: 'Blame path is outside the repository' };
        if (!(await lstat(file)).isFile()) return { success: false, errorCode: 'unsupported_path', error: 'Blame requires a regular text file' };
        const bytes = await readFile(file);
        const hash = createHash('sha256').update(bytes).digest('hex');
        if (request.expectedHash && request.expectedHash !== hash) return { success: false, errorCode: 'stale_file' };
        if (bytes.includes(0)) return { success: false, errorCode: 'unsupported_path', error: 'Binary files have no line blame' };
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { return { success: false, errorCode: 'unsupported_path', error: 'Blame requires UTF-8 text' }; }
        const tracked = await runScmCommand({ bin: 'git', cwd: root, args: ['ls-files', '--error-unmatch', '--', normalized.pathspec], signal });
        if (signal?.aborted) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED };
        if (!tracked.success) {
            if (tracked.exitCode === 1 && !tracked.timedOut && !tracked.outputLimitExceeded) return { success: false, errorCode: 'untracked' };
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: tracked.stderr || 'Failed to check blame path' };
        }
        const reader = createGitBlameReader();
        // Unlike diff, blame takes one literal filename, not a Git pathspec.
        const result = await runScmCommand({ bin: 'git', cwd: root, args: ['blame', '--incremental', '--', normalized.relativePath], signal, stdoutConsumer: reader.consume });
        if (signal?.aborted) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED };
        if (!result.success) {
            if (result.outputLimitExceeded || result.timedOut) return { success: false,
                errorCode: result.outputLimitExceeded ? SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED : SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT,
                error: result.stderr || 'Failed to read blame' };
            const head = await runScmCommand({ bin: 'git', cwd: root, args: ['rev-parse', '--verify', '--quiet', 'HEAD'], signal });
            if (head.exitCode === 1 && !head.timedOut && !head.outputLimitExceeded) return { success: false, errorCode: 'untracked' };
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: result.stderr || 'Failed to read blame' };
        }
        // The displayed bytes may have changed while Git was reading. Never
        // publish ranges against another version, even when no hash was supplied.
        if (createHash('sha256').update(await readFile(file)).digest('hex') !== hash) return { success: false, errorCode: 'stale_file' };
        const response = reader.finish();
        if (!response.success) return response;
        let lines = bytes.length > 0 && bytes.at(-1) !== 10 ? 1 : 0;
        for (const byte of bytes) if (byte === 10) lines += 1;
        if (response.ranges.reduce((count, range) => count + range.lineCount, 0) !== lines) throw new Error('Blame does not cover the current file');
        return response;
    } catch (error) {
        if (request.expectedHash && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return { success: false, errorCode: 'stale_file' };
        }
        return { success: false, errorCode: signal?.aborted ? SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: error instanceof Error ? error.message : 'Failed to read blame' };
    }
}

const GIT_LOG_FIELDS_PER_ENTRY = 7;

/** --raw -z frames a diff metadata token followed by one literal filename.
 * --no-renames keeps this pair grammar and explicitly does not follow old names.
 * Commit headers are separate NUL fields; filenames never pass through trim/line parsing.
 */
function createEntryHistoryReader(demanded: readonly { path: string; historyPath: string; directory: boolean }[], shallow: ReadonlySet<string>) {
    const decoder = new StringDecoder('utf8');
    const pending: string[] = [];
    const settled = new Map<string, ScmEntryHistoryV1>();
    const demandedCount = new Set(demanded.map(entry => entry.path)).size;
    let commit: Extract<ScmEntryHistoryV1, { kind: 'commit' }>['commit'] | undefined;
    let phase: 'frame' | 'author' | 'timestamp' | 'subject' | 'path' = 'frame';
    let oid = '';
    let authorName = '';
    let committedAt = 0;
    const consumeToken = (token: string) => {
        if (phase === 'author') { authorName = token; phase = 'timestamp'; return; }
        if (phase === 'timestamp') {
            if (!/^-?\d+$/.test(token)) throw new Error('Invalid history timestamp frame');
            committedAt = Number(token) * 1000;
            phase = 'subject';
            return;
        }
        if (phase === 'subject') {
            commit = { oid, authorName, committedAt, subject: token };
            phase = 'frame';
            return;
        }
        if (phase === 'path') {
            if (!commit || token === '') throw new Error('Missing history path frame');
            phase = 'frame';
            // Shallow root inventories cannot establish actual touches.
            if (shallow.has(commit.oid)) return;
            for (const entry of demanded) {
                const matches = entry.directory
                    ? entry.historyPath === '' || token.startsWith(`${entry.historyPath}/`)
                    : token === entry.historyPath;
                if (matches && !settled.has(entry.path)) settled.set(entry.path, { path: entry.path, kind: 'commit', commit });
            }
            return;
        }
        if (token === '' || token === '\n') return;
        const metadata = token.startsWith('\n') ? token.slice(1) : token;
        if (metadata.startsWith(':')) {
            if (!commit || !/^:[0-7]{6} [0-7]{6} [a-f0-9]+ [a-f0-9]+ [A-Z]$/.test(metadata)) throw new Error('Invalid history diff frame');
            phase = 'path';
            return;
        }
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(token)) throw new Error('Invalid history commit frame');
        oid = token;
        phase = 'author';
    };
    return {
        consume(chunk: Uint8Array): 'continue' | 'stop' {
            const text = decoder.write(Buffer.from(chunk));
            let start = 0;
            let end: number;
            while ((end = text.indexOf('\0', start)) >= 0) {
                const token = pending.length > 0 ? [...pending, text.slice(start, end)].join('') : text.slice(start, end);
                pending.length = 0;
                consumeToken(token);
                if (settled.size === demandedCount) return 'stop';
                start = end + 1;
            }
            if (start < text.length) pending.push(text.slice(start));
            return 'continue';
        },
        finish() {
            if (decoder.end() !== '' || pending.length > 0 || phase !== 'frame') throw new Error('Unterminated history frame');
        },
        entries(incompleteReason?: string): ScmEntryHistoryV1[] {
            return demanded.map(({ path }) => settled.get(path) ?? (incompleteReason || shallow.size > 0
                ? { path, kind: 'unavailable', reason: incompleteReason ?? 'shallow_history' }
                : { path, kind: 'none' }));
        },
    };
}

export async function gitHistoryEntries(input: {
    context: ScmBackendContext;
    request: ScmHistoryEntriesRequest;
    signal?: AbortSignal;
}): Promise<ScmHistoryEntriesResponse> {
    const parsed = ScmHistoryEntriesInputV1Schema.safeParse(input.request);
    if (!parsed.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Invalid entry-history request' };
    const { context } = input;
    const request = parsed.data;
    if (!context.detection.isRepo) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY };
    const cwd = context.detection.rootPath ?? context.cwd;
    const signal = input.signal;
    const command = (args: string[]) => runScmCommand({ bin: 'git', cwd, args, signal });
    const head = await command(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    const headOid = head.success ? head.stdout.trim() : null;
    if (!head.success) {
        // A missing symbolic branch is unborn. A missing/damaged detached object,
        // a failed probe or cancellation is not evidence of an empty history.
        if (signal?.aborted) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED };
        if (head.exitCode !== 1 || head.timedOut || head.outputLimitExceeded) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: head.stderr };
        const symbolic = await command(['symbolic-ref', '--quiet', 'HEAD']);
        if (!symbolic.success) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: symbolic.stderr };
        const branch = await command(['show-ref', '--verify', '--quiet', symbolic.stdout.trim()]);
        if (branch.success || branch.exitCode !== 1 || branch.timedOut || branch.outputLimitExceeded) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: branch.stderr };
        if (request.headOid !== undefined) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED, headOid: null };
        return { success: true, headOid: null, entries: request.paths.map(path => ({ path, kind: 'none' })) };
    }
    if (request.headOid !== undefined && request.headOid !== headOid) return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.SCM_SOURCE_CHANGED, headOid };
    const unavailable = (reason: string): ScmHistoryEntriesResponse => ({ success: true, headOid, entries: request.paths.map(path => ({ path, kind: 'unavailable', reason })) });
    if (request.paths.length === 0) return { success: true, headOid, entries: [] };
    let historyFolder = request.folder;
    if (process.platform === 'win32' && request.folder !== '') {
        // Qualified Windows workspace identities may lose directory casing. Recover
        // this batch's folder spelling at the OS boundary, not by folding Git names.
        // Native realpath must not turn a symlink/alias into a different Git identity.
        const folderPath = resolve(cwd, request.folder);
        context.assertFilesystemPathAuthorized?.(folderPath);
        try {
            if (!(await lstat(folderPath)).isDirectory()) return unavailable('history_folder_unavailable');
            const physicalRoot = await realpath(cwd);
            const expectedFolder = resolve(physicalRoot, request.folder);
            const physicalFolder = await realpath(expectedFolder);
            if (!isCanonicalAbsolutePathInsideRoot(physicalRoot, physicalFolder)
                || !isCanonicalAbsolutePathInsideRoot(expectedFolder, physicalFolder)
                || !isCanonicalAbsolutePathInsideRoot(physicalFolder, expectedFolder)) {
                return unavailable('history_folder_unavailable');
            }
            historyFolder = relative(physicalRoot, physicalFolder).split(sep).join('/');
        } catch { return unavailable('history_folder_unavailable'); }
    }
    const demanded = await Promise.all(request.paths.map(async path => {
        const historyPath = historyFolder === request.folder ? path : `${historyFolder}${path.slice(request.folder.length)}`;
        const absolutePath = resolve(cwd, historyPath);
        context.assertFilesystemPathAuthorized?.(absolutePath);
        try { return { path, historyPath, directory: (await lstat(absolutePath)).isDirectory() }; }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { path, historyPath, directory: false };
            throw error;
        }
    }));
    const shallowPath = await command(['rev-parse', '--git-path', 'shallow']);
    if (!shallowPath.success) return unavailable('history_probe_failed');
    let shallow: Set<string>;
    try { shallow = new Set((await readFile(resolve(cwd, shallowPath.stdout.trim()), 'utf8')).split('\n').filter(Boolean)); }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') shallow = new Set();
        else return unavailable('history_probe_failed');
    }
    const reader = createEntryHistoryReader(demanded, shallow);
    let invalidOutput = false;
    const history = await runScmCommand({ bin: 'git', cwd, signal, args: [
        'log', '--full-history', '--date-order', '--raw', '-z', '--no-renames', '--root', '-m',
        '--format=%x00%H%x00%an%x00%ct%x00%s%x00',
        // An empty top-level literal pathspec selects the whole root. Literal
        // '.' selects no tracked paths, unlike Git's ordinary dot pathspec.
        headOid!, '--', ...demanded.map(({ historyPath }) => toRepoRootLiteralPathspec(historyPath)),
    ], stdoutConsumer: chunk => {
        try { return reader.consume(chunk); }
        catch (error) { invalidOutput = true; throw error; }
    } });
    if (signal?.aborted) return unavailable('cancelled');
    if (invalidOutput) return unavailable('invalid_history_output');
    if (!history.success && !history.outputLimitExceeded) return unavailable(history.timedOut ? 'command_timeout' : 'history_command_failed');
    try {
        if (history.success && !history.stoppedEarly) reader.finish();
        return ScmHistoryEntriesResponseSchema.parse({ success: true, headOid,
            entries: reader.entries(history.outputLimitExceeded ? 'command_output_limit_exceeded' : undefined) });
    } catch { return unavailable('invalid_history_output'); }
}

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

    if (request.revisionRange !== undefined) {
        const parsed = ScmRevisionRangeV1Schema.safeParse(request.revisionRange);
        if (!parsed.success || request.range !== undefined || request.query !== undefined) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, error: 'Exact revision ranges require immutable endpoints and no other log selector' };
        }
        const range = parsed.data;
        const command = (args: string[]) => runScmCommand({ bin: 'git', cwd: context.detection.rootPath ?? context.cwd,
            args, signal: input.signal, env: { GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' } });
        const failure = (result: Awaited<ReturnType<typeof command>>): ScmLogListResponse => ({ success: false,
            errorCode: input.signal?.aborted ? SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED
                : result.outputLimitExceeded ? SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED
                : result.timedOut ? SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT : SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: result.stderr || 'Exact revision range history is unavailable' });
        const endpoints = await Promise.all([range.baseOid, range.headOid].map(oid =>
            command(['rev-parse', '--verify', '--end-of-options', `${oid}^{commit}`])));
        for (const [index, endpoint] of endpoints.entries()) {
            if (!endpoint.success || endpoint.stdout.trim() !== [range.baseOid, range.headOid][index]) return failure(endpoint);
        }
        const shallow = await command(['rev-parse', '--is-shallow-repository']);
        if (!shallow.success || !['true', 'false'].includes(shallow.stdout.trim())) return failure(shallow);
        const historyComplete = shallow.stdout.trim() === 'false';
        let graphRelation: 'equal' | 'forward' | 'diverged' | undefined;
        let totalCount: number | undefined;
        if (historyComplete) {
            const count = await command(['rev-list', '--count', `${range.baseOid}..${range.headOid}`, '--']);
            if (!count.success) return failure(count);
            totalCount = Number(count.stdout.trim());
            if (!/^\d+$/u.test(count.stdout.trim()) || !Number.isSafeInteger(totalCount) || totalCount < 0) {
                return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: 'Invalid exact revision range count' };
            }
            if (range.baseOid === range.headOid) graphRelation = 'equal';
            else {
                const ancestry = await command(['merge-base', '--is-ancestor', range.baseOid, range.headOid]);
                if (ancestry.success) graphRelation = 'forward';
                else if (ancestry.exitCode === 1 && !ancestry.timedOut && !ancestry.outputLimitExceeded && !input.signal?.aborted) graphRelation = 'diverged';
                else return failure(ancestry);
            }
        }
        // One lookahead uses the existing page size and distinguishes an exhausted
        // exact range from a full page; HEAD and mutable branch refs never participate.
        const log = await command(['log', `--max-count=${limit + 1}`, `--skip=${skip}`,
            '--pretty=format:%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%b%x00', `${range.baseOid}..${range.headOid}`, '--']);
        if (!log.success) return failure(log);
        const entries = parseGitLogEntries(log.stdout);
        // A truncated or malformed frame cannot establish full-range coverage.
        if ((log.stdout && !log.stdout.endsWith('\0')) || (log.stdout.match(/\0/g)?.length ?? 0) !== entries.length * GIT_LOG_FIELDS_PER_ENTRY
            || entries.some(entry => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.sha))) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, error: 'Invalid exact revision range history' };
        }
        return { success: true, entries: entries.slice(0, limit), revisionRange: { ...range,
            historyComplete, ...(graphRelation !== undefined && totalCount !== undefined ? { graphRelation, totalCount } : {}),
            ...(entries.length > limit ? { nextSkip: skip + limit } : {}) } };
    }

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
