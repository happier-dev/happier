import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';

import type {
    SessionMediaPublishGeneratedRequest,
    SessionMediaService,
    SessionMediaSourceRoot,
} from '@happier-dev/plugin-sdk/sessions';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';

type ActiveMediaScope = Readonly<{
    sessionId: string;
    rootPath: string;
    sendAgentSessionMediaCommitted: NonNullable<TranscriptSessionPort['sendAgentSessionMediaCommitted']>;
}>;

function requireNonblank(value: string, code: string): void {
    if (value.trim().length === 0) throw new Error(code);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw new Error(typeof signal.reason === 'string' && signal.reason.trim() ? signal.reason : 'media_operation_aborted');
}

async function resolveAuthorizedMediaPath(
    mediaPath: string,
    canonicalRoot: string,
): Promise<string> {
    if (
        typeof mediaPath !== 'string'
        || mediaPath.length === 0
        || mediaPath.length > 4096
        || !isAbsolute(mediaPath)
    ) {
        throw new Error('media_path_invalid');
    }
    const stat = await lstat(mediaPath).catch(() => {
        throw new Error('media_path_invalid');
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('media_path_invalid');
    const canonicalPath = await realpath(mediaPath).catch(() => {
        throw new Error('media_path_invalid');
    });
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (
        relativePath.length === 0
        || relativePath === '..'
        || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || isAbsolute(relativePath)
    ) {
        throw new Error('media_path_forbidden');
    }
    return canonicalPath;
}

export function createPluginSessionMediaHostAdapter(params: Readonly<{
    agentId: string;
    readActiveScope(): ActiveMediaScope | null;
}>): Readonly<{
    current: SessionMediaService;
    forSession(sessionId: string): SessionMediaService;
    forAuthorizedSession(
        sessionId: string,
        authorizeSourceRoot: (canonicalRoot: string) => boolean | Promise<boolean>,
    ): SessionMediaService;
    dispose(): void;
}> {
    let disposed = false;
    const roots = new Set<{ revoked: boolean }>();

    const createService = (
        fixedSessionId: string | null,
        authorizeSourceRoot?: (canonicalRoot: string) => boolean | Promise<boolean>,
    ): SessionMediaService => Object.freeze({
        async registerSourceRoot(
            request: Readonly<{ rootPath: string }>,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<SessionMediaSourceRoot> {
            throwIfAborted(options?.signal);
            if (disposed) throw new Error('media_adapter_disposed');
            if (!authorizeSourceRoot) throw new Error('media_source_root_forbidden');
            requireNonblank(request.rootPath, 'media_source_root_invalid');
            const scope = params.readActiveScope();
            if (!scope || (fixedSessionId !== null && scope.sessionId !== fixedSessionId)) {
                throw new Error('media_session_scope_forbidden');
            }
            if (!isAbsolute(request.rootPath)) throw new Error('media_source_root_invalid');
            const rootStat = await lstat(request.rootPath).catch(() => {
                throw new Error('media_source_root_invalid');
            });
            throwIfAborted(options?.signal);
            if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
                throw new Error('media_source_root_invalid');
            }
            const canonicalRoot = await realpath(request.rootPath);
            throwIfAborted(options?.signal);
            if (!await authorizeSourceRoot(canonicalRoot)) {
                throw new Error('media_source_root_forbidden');
            }
            throwIfAborted(options?.signal);
            if (disposed) throw new Error('media_adapter_disposed');
            const currentScope = params.readActiveScope();
            if (!currentScope || currentScope.sessionId !== scope.sessionId) {
                throw new Error('media_session_scope_forbidden');
            }
            const registration = { revoked: false };
            roots.add(registration);
            const publishGenerated = async (
                media: SessionMediaPublishGeneratedRequest,
                publishOptions?: Readonly<{ signal?: AbortSignal }>,
            ) => {
                throwIfAborted(publishOptions?.signal);
                if (disposed || registration.revoked) {
                    throw new Error('media_source_root_revoked');
                }
                const active = params.readActiveScope();
                if (!active || active.sessionId !== scope.sessionId) {
                    throw new Error('media_session_scope_forbidden');
                }
                requireNonblank(media.localId, 'media_local_id_invalid');
                requireNonblank(media.path, 'media_path_invalid');
                const currentRootStat = await lstat(request.rootPath).catch(() => {
                    throw new Error('media_source_root_revoked');
                });
                if (!currentRootStat.isDirectory() || currentRootStat.isSymbolicLink()) {
                    throw new Error('media_source_root_revoked');
                }
                const currentCanonicalRoot = await realpath(request.rootPath).catch(() => {
                    throw new Error('media_source_root_revoked');
                });
                throwIfAborted(publishOptions?.signal);
                if (currentCanonicalRoot !== canonicalRoot) {
                    throw new Error('media_source_root_revoked');
                }
                if (
                    media.referencePaths !== undefined
                    && !Array.isArray(media.referencePaths)
                ) {
                    throw new Error('media_reference_paths_invalid');
                }
                const referencePaths = [...(media.referencePaths ?? [])].slice(0, 64);
                const canonicalPaths = await Promise.all(
                    [media.path, ...referencePaths].map(
                        (path) => resolveAuthorizedMediaPath(path, canonicalRoot),
                    ),
                );
                throwIfAborted(publishOptions?.signal);
                const sourceAccessPolicy = {
                    kind: 'restrictedRoots' as const,
                    roots: [canonicalRoot],
                };
                const commitScope = params.readActiveScope();
                if (!commitScope || commitScope.sessionId !== scope.sessionId) {
                    throw new Error('media_session_scope_forbidden');
                }
                await commitScope.sendAgentSessionMediaCommitted(params.agentId, {
                    localId: media.localId,
                    role: 'output',
                    category: 'generated',
                    media: canonicalPaths.map((path, index) => ({
                        source: {
                            kind: 'local-file' as const,
                            path,
                            fileNameHint: basename(path),
                        },
                        origin: {
                            source: 'provider-generated' as const,
                            agentId: params.agentId,
                            ...(index === 0 && media.toolCallId !== undefined
                                ? { toolCallId: media.toolCallId }
                                : {}),
                        },
                        sourceAccessPolicy,
                        ...(media.createdAtMs === undefined
                            ? {}
                            : { createdAtMs: media.createdAtMs }),
                    })),
                    meta: {
                        ...(media.description
                            ? { description: media.description.slice(0, 4096) }
                            : {}),
                        ...(referencePaths.length > 0
                            ? { referenceCount: referencePaths.length }
                            : {}),
                    },
                });
                throwIfAborted(publishOptions?.signal);
                const settledScope = params.readActiveScope();
                if (!settledScope || settledScope.sessionId !== scope.sessionId) {
                    throw new Error('media_session_scope_forbidden');
                }
                return { status: 'published' as const };
            };
            return Object.freeze({
                publishGenerated,
                dispose() {
                    registration.revoked = true;
                    roots.delete(registration);
                },
            });
        },
    });

    return Object.freeze({
        current: createService(null),
        forSession: (sessionId) => createService(sessionId),
        forAuthorizedSession: (sessionId, authorizeSourceRoot) => (
            createService(sessionId, authorizeSourceRoot)
        ),
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const registration of roots) registration.revoked = true;
            roots.clear();
        },
    });
}
