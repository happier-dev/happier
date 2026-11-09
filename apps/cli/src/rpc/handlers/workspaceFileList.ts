import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { DaemonWorkspaceFileListRequestSchema, WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES } from '@happier-dev/protocol/machines/workspaceFiles';
import type { DaemonWorkspaceFileListResponse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSafeRelativeWorkspacePath, workspaceFileExclusionArguments } from './workspaceFilePaths';
import { logger } from '@/ui/logger';


function escapeRipgrepGlob(input: string): string {
    return input
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}');
}

function buildWorkspaceFileListArguments(query: string | undefined, includeHidden: boolean): string[] {
    const args = [
        '--no-config',
        '--files',
        ...(includeHidden ? ['--hidden'] : []),
        // Native line buffering flushes each filename before traversal completes.
        '--line-buffered',
    ];
    const trimmed = query?.trim();
    if (trimmed) {
        const needle = escapeRipgrepGlob(trimmed).replace(/\s+/g, '*');
        // A filename query also names directories. Include their descendants so
        // the UI can project matching folders from the same canonical file list.
        args.push('--iglob', `*${needle}*`, '--iglob', `**/*${needle}*/**`);
    }
    // Keep exclusions authoritative after the positive query globs.
    args.push(...workspaceFileExclusionArguments('--iglob'));
    return args;
}

function selectBoundedPaths(input: Readonly<{
    stdout: string;
    stdoutTruncated: boolean;
    limit?: number;
}>): Readonly<{ paths: string[]; truncated: boolean }> {
    const rawPaths = input.stdout.split('\n');
    // A byte limit or deadline can bisect the final record. Even a normal exit
    // cannot make an unterminated path a complete native filename record.
    const trailingRecord = rawPaths.pop() ?? '';

    const paths: string[] = [];
    let serializedBytes = Buffer.byteLength(JSON.stringify({ ok: true, paths: [], truncated: false }), 'utf8');
    let truncated = input.stdoutTruncated || trailingRecord.length > 0;
    for (const rawPath of rawPaths) {
        const path = process.platform === 'win32' ? rawPath.replace(/\r$/u, '') : rawPath;
        const normalized = path.replace(/\\/g, '/').replace(/^\.\//u, '');
        if (!isSafeRelativeWorkspacePath(normalized)) {
            truncated = true;
            continue;
        }
        if (input.limit !== undefined && paths.length >= input.limit) {
            truncated = true;
            break;
        }
        const nextBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + (paths.length > 0 ? 1 : 0);
        if (serializedBytes + nextBytes > WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES) {
            truncated = true;
            break;
        }
        paths.push(normalized);
        serializedBytes += nextBytes;
    }
    return { paths, truncated };
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export function registerWorkspaceFileListHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    rpcHandlerManager.registerHandler<unknown, DaemonWorkspaceFileListResponse>(
        RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
        async (raw, context) => {
            const parsed = DaemonWorkspaceFileListRequestSchema.safeParse(raw);
            if (!parsed.success) return { ok: false, errorCode: 'invalid_request' };

            const authorization = authorizeFilesystemPath({
                targetPath: parsed.data.rootPath,
                defaultDirectory: workingDirectory,
                accessPolicy,
            });
            if (!authorization.valid) return { ok: false, errorCode: 'path_not_allowed' };

            try {
                context?.signal.throwIfAborted();
                const result = await runRipgrep(buildWorkspaceFileListArguments(
                    parsed.data.query,
                    parsed.data.includeHidden === true,
                ), {
                    cwd: authorization.resolvedPath,
                    ...(context?.signal ? { signal: context.signal } : {}),
                    maxStdoutBytes: WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES,
                    // Reuse the operation's payload boundary for native diagnostics;
                    // only OS codes are retained in the file log, never paths/prose.
                    maxStderrBytes: WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES,
                    terminateOnStdoutLimit: true,
                    ...(parsed.data.budgetMs === undefined ? {} : {
                        deadlineAtMs: (context?.requestStartedAtMs ?? Date.now()) + parsed.data.budgetMs,
                    }),
                });
                context?.signal.throwIfAborted();
                if (result.deadlineExceeded) logger.infoFile('[WORKSPACE FILE LIST] Budget exhausted');
                if (result.exitCode === 127) return { ok: false, errorCode: 'ripgrep_unavailable' };
                const osErrorCodes = [...new Set([...result.stderr.matchAll(/\(os error (\d+)\)/gu)]
                    .map(match => Number(match[1])).filter(Number.isSafeInteger))].sort((a, b) => a - b);
                const traversalIncomplete = result.exitCode === 2 && osErrorCodes.length > 0;
                if (traversalIncomplete) logger.infoFile('[WORKSPACE FILE LIST] Traversal incomplete', {
                    exitCode: result.exitCode, osErrorCodes,
                });
                const isEmptyResult = result.exitCode === 1 && result.stdout.length === 0;
                const bounded = selectBoundedPaths({
                    stdout: result.stdout,
                    // Exit 2 includes traversal failures (for example an unreadable
                    // sibling). Usable paths remain valid, but coverage is partial.
                    stdoutTruncated: result.stdoutTruncated === true || result.exitCode === 2,
                    limit: parsed.data.limit,
                });
                if (result.exitCode !== 0 && !isEmptyResult && !result.stdoutTruncated) {
                    if (result.exitCode !== 2 || (bounded.paths.length === 0 && !traversalIncomplete)) {
                        return { ok: false, errorCode: 'ripgrep_failed', exitCode: result.exitCode };
                    }
                }
                return {
                    ok: true,
                    ...bounded,
                };
            } catch (error) {
                if (context?.signal?.aborted || isAbortError(error)) throw error;
                if (error instanceof Error && 'code' in error && error.code === 'WORKSPACE_ROOT_NOT_FOUND') {
                    return { ok: false, errorCode: 'root_not_found' };
                }
                return { ok: false, errorCode: 'ripgrep_unavailable' };
            }
        },
    );
}
