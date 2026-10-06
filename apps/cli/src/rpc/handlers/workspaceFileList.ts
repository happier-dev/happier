import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';
import { DaemonWorkspaceFileListRequestSchema, WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES, WORKSPACE_FILE_LIST_MAX_RESULTS } from '@happier-dev/protocol/machines/workspaceFiles';
import type { DaemonWorkspaceFileListResponse } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSafeRelativeWorkspacePath, workspaceFileExclusionArguments } from './workspaceFilePaths';


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
        '--null',
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
    limit: number;
}>): Readonly<{ paths: string[]; truncated: boolean }> {
    const completeOutput = !input.stdoutTruncated || input.stdout.endsWith('\0');
    const rawPaths = input.stdout.split('\0');
    if (!completeOutput) rawPaths.pop();
    if (rawPaths.at(-1) === '') rawPaths.pop();

    const paths: string[] = [];
    let serializedBytes = Buffer.byteLength(JSON.stringify({ ok: true, paths: [], truncated: false }), 'utf8');
    let truncated = input.stdoutTruncated;
    for (const rawPath of rawPaths) {
        const normalized = rawPath.replace(/\\/g, '/').replace(/^\.\//u, '');
        if (!isSafeRelativeWorkspacePath(normalized)) {
            truncated = true;
            continue;
        }
        if (paths.length >= input.limit) {
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
                const result = await runRipgrep(buildWorkspaceFileListArguments(
                    parsed.data.query,
                    parsed.data.includeHidden === true,
                ), {
                    cwd: authorization.resolvedPath,
                    ...(context?.signal ? { signal: context.signal } : {}),
                    maxStdoutBytes: WORKSPACE_FILE_LIST_MAX_RESPONSE_UTF8_BYTES,
                    // The typed operation never exposes diagnostics, so retain none of them.
                    maxStderrBytes: 0,
                    terminateOnStdoutLimit: true,
                });
                if (result.exitCode === 127) return { ok: false, errorCode: 'ripgrep_unavailable' };
                const isEmptyResult = result.exitCode === 1 && result.stdout.length === 0;
                const bounded = selectBoundedPaths({
                    stdout: result.stdout,
                    // Exit 2 includes traversal failures (for example an unreadable
                    // sibling). Usable paths remain valid, but coverage is partial.
                    stdoutTruncated: result.stdoutTruncated === true || result.exitCode === 2,
                    limit: parsed.data.limit ?? WORKSPACE_FILE_LIST_MAX_RESULTS,
                });
                if (result.exitCode !== 0 && !isEmptyResult && !result.stdoutTruncated) {
                    if (result.exitCode !== 2 || bounded.paths.length === 0) {
                        return { ok: false, errorCode: 'ripgrep_failed', exitCode: result.exitCode };
                    }
                }
                return {
                    ok: true,
                    ...bounded,
                };
            } catch (error) {
                if (context?.signal?.aborted || isAbortError(error)) throw error;
                return { ok: false, errorCode: 'ripgrep_unavailable' };
            }
        },
    );
}
