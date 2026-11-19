import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod/mini';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { FilesystemEffectChannel } from '@/rpc/handlers/fileSystem/filesystemEffectChannel';
import type { FilesystemEffectConfiguration } from '@/rpc/handlers/fileSystem/filesystemEffectOperation';
import type { AgentTranscriptFileFollowHandle, AgentTranscriptFileFollowService } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginExecutionScopeV1 } from '@happier-dev/protocol';

import { PluginContextServiceError } from '../errors';

export type TranscriptFileFollowPathGrantReason =
    | 'providerTranscriptSource'
    | 'externalSessionTranscript'
    | 'testFixture';

export type TranscriptFileFollowPathGrantEvidence =
    | Readonly<{ kind: 'sessionStartTranscriptPath'; providerSessionId?: string }>
    | Readonly<{ kind: 'authenticatedStatuslineTranscriptPath'; providerSessionId?: string }>
    | Readonly<{ kind: 'acpProviderSessionJournal'; providerSessionId: string }>
    | Readonly<{ kind: 'hostMaterializedTranscriptPath'; sourceId?: string }>
    | Readonly<{ kind: 'testOnly' }>;

export type TranscriptFileFollowPathGrantScope = Readonly<{
    pluginId: string;
    runtimeId: string;
    scope?: PluginExecutionScopeV1 | null;
}>;

export type TranscriptFileFollowPathGrantInput = TranscriptFileFollowPathGrantScope & Readonly<{
    path: string;
    reason: TranscriptFileFollowPathGrantReason;
    evidence: TranscriptFileFollowPathGrantEvidence;
    expiresAtMs?: number;
}>;

export type TranscriptFileFollowPathGrantAuthorizeRequest = TranscriptFileFollowPathGrantScope & Readonly<{
    path: string;
}>;

export type TranscriptFileFollowPathGrantResolution = Readonly<{
    path: string;
    expiresAtMs?: number;
}>;

export type TranscriptFileFollowPathGrantHandle = Readonly<{
    id: string;
    revoke(): Promise<void>;
}>;

export type TranscriptFileFollowPathGrantRegistry = Readonly<{
    grant(input: TranscriptFileFollowPathGrantInput): Promise<TranscriptFileFollowPathGrantHandle>;
    grantOwnedPrompt(scope: TranscriptFileFollowPathGrantScope, member: MemberTranscriptFilesystem,
        input: OwnedPromptFollowInput): Promise<AgentTranscriptFileFollowHandle>;
    resolveFollowPath(
        request: TranscriptFileFollowPathGrantAuthorizeRequest,
    ): Promise<TranscriptFileFollowPathGrantResolution | null>;
    canFollowPath(request: TranscriptFileFollowPathGrantAuthorizeRequest): Promise<boolean>;
    revokeScope(scope: TranscriptFileFollowPathGrantScope): Promise<void>;
}>;

type ScopedGrant = Readonly<{
    id: string;
    pluginId: string;
    runtimeId: string;
    scopeKey: string | null;
}>;

type StoredTranscriptFileFollowPathGrant = ScopedGrant & Readonly<{
    realPath: string;
    pendingPath: string | null;
    reason: TranscriptFileFollowPathGrantReason;
    evidence: TranscriptFileFollowPathGrantEvidence;
    expiresAtMs: number | null;
}>;

type OwnedPromptFollowInput = Parameters<NonNullable<AgentTranscriptFileFollowService['followOwnedPrompt']>>[0];
export type MemberTranscriptFilesystem = Readonly<{
    home: string;
    open(configuration: FilesystemEffectConfiguration, signal: AbortSignal): Promise<FilesystemEffectChannel>;
}>;

const memberTranscriptSnapshotSchema = z.strictObject({
    path: z.string(),
    fileIdentity: z.nullable(z.string()),
    sizeBytes: z.number().check(z.int(), z.nonnegative()),
    contentBase64: z.string(),
});

export function createTranscriptFileFollowPathGrantRegistry(): TranscriptFileFollowPathGrantRegistry {
    const grantsById = new Map<string, StoredTranscriptFileFollowPathGrant | (ScopedGrant & Readonly<{ close(): Promise<void> }>)>();

    async function revoke(id: string): Promise<void> {
        grantsById.delete(id);
    }

    async function resolveFollowPath(
        request: TranscriptFileFollowPathGrantAuthorizeRequest,
    ): Promise<TranscriptFileFollowPathGrantResolution | null> {
        const scope = normalizeTranscriptFileFollowGrantScope(request);
        const normalizedPath = normalizeTranscriptFileFollowAbsolutePath(request.path);
        if (!normalizedPath) {
            return null;
        }
        const realPath = await resolveTranscriptFileFollowRealPath(normalizedPath);
        const pendingPath = realPath ? null : await resolvePendingTranscriptPath(normalizedPath);
        if (!realPath && !pendingPath) return null;
        const now = Date.now();
        for (const grant of grantsById.values()) {
            if ('close' in grant) continue;
            if (grant.expiresAtMs !== null && grant.expiresAtMs <= now) {
                grantsById.delete(grant.id);
                continue;
            }
            if (
                grant.pluginId === scope.pluginId
                && grant.runtimeId === scope.runtimeId
                && grant.scopeKey === scope.scopeKey
                && (grant.realPath === realPath
                    || (grant.pendingPath === normalizedPath && grant.realPath === pendingPath))
            ) {
                return Object.freeze({
                    path: grant.realPath,
                    ...(grant.expiresAtMs !== null ? { expiresAtMs: grant.expiresAtMs } : {}),
                });
            }
        }
        return null;
    }

    return Object.freeze({
        async grantOwnedPrompt(scopeInput, member, input): Promise<AgentTranscriptFileFollowHandle> {
            const scope = normalizeTranscriptFileFollowGrantScope(scopeInput);
            if (scopeInput.scope?.kind !== 'session' || !normalizeTranscriptFileFollowAbsolutePath(input.path)) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
                    'Native transcript proof requires an absolute path and a Session scope',
                );
            }
            input.signal.throwIfAborted();
            const channel = await member.open({
                workingDirectory: member.home,
                accessPolicy: { kind: 'restrictedRoots', roots: [member.home] },
                memberTranscript: { home: member.home, path: input.path.trim() },
            }, input.signal);
            const id = `transcript-file-follow-grant:${randomUUID()}`;
            const close = async () => {
                grantsById.delete(id);
                await channel.dispose();
            };
            grantsById.set(id, { id, ...scope, close });
            try {
                const baseline = memberTranscriptSnapshotSchema.parse(await channel.request({ kind: 'transcript.baseline' }));
                input.signal.throwIfAborted();
                let drain: Promise<void> | undefined;
                return { id, close, drainNow() {
                    return drain ??= (async () => {
                        let offset = baseline.sizeBytes;
                        let fileIdentity = baseline.fileIdentity;
                        let discardPartialRow = offset > 0 && Buffer.from(baseline.contentBase64, 'base64')[0] !== 10;
                        const decoder = new StringDecoder('utf8');
                        let trailing = '';
                        let sequence = 0;
                        let end: number | undefined;
                        while (grantsById.has(id)) {
                            const page = memberTranscriptSnapshotSchema.parse(await channel.request({
                                kind: 'transcript.read', offset, fileIdentity,
                            }));
                            if (!grantsById.has(id)) return;
                            if (fileIdentity && page.fileIdentity !== fileIdentity) {
                                await input.onReset?.({ reason: page.fileIdentity ? 'replaced' : 'missing' });
                                return;
                            }
                            if (page.sizeBytes < offset) {
                                await input.onReset?.({ reason: 'truncated' });
                                return;
                            }
                            fileIdentity = page.fileIdentity;
                            end ??= page.sizeBytes;
                            const bytes = Buffer.from(page.contentBase64, 'base64').subarray(0, end - offset);
                            if (bytes.length === 0) return;
                            offset += bytes.length;
                            const lines = (trailing + decoder.write(bytes)).split('\n');
                            trailing = lines.pop() ?? '';
                            for (const line of lines) {
                                if (!grantsById.has(id)) return;
                                if (discardPartialRow) {
                                    discardPartialRow = false;
                                    continue;
                                }
                                await input.onLine({ line, sourcePath: baseline.path, sequence: ++sequence });
                            }
                            if (offset === end) return;
                        }
                    })();
                } };
            } catch (error) {
                await close().catch(() => undefined);
                throw error;
            }
        },
        async grant(input): Promise<TranscriptFileFollowPathGrantHandle> {
            const scope = normalizeTranscriptFileFollowGrantScope(input);
            const normalizedPath = normalizeTranscriptFileFollowAbsolutePath(input.path);
            if (!normalizedPath) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
                    'Transcript file-follow grants require an absolute transcript path',
                );
            }
            let realPath = await resolveTranscriptFileFollowRealPath(normalizedPath);
            let pendingPath: string | null = null;
            if (!realPath && (input.evidence.kind === 'sessionStartTranscriptPath'
                || input.evidence.kind === 'authenticatedStatuslineTranscriptPath'
                || input.evidence.kind === 'acpProviderSessionJournal')) {
                pendingPath = normalizedPath;
                realPath = await resolvePendingTranscriptPath(normalizedPath);
            }
            if (!realPath) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
                    'Transcript file-follow grant path could not be resolved',
                );
            }
            const expiresAtMs = normalizeGrantExpiresAtMs(input.expiresAtMs);
            const id = `transcript-file-follow-grant:${randomUUID()}`;
            grantsById.set(id, Object.freeze({
                id,
                ...scope,
                realPath,
                pendingPath,
                reason: input.reason,
                evidence: input.evidence,
                expiresAtMs,
            }));
            return Object.freeze({
                id,
                revoke: () => revoke(id),
            });
        },
        resolveFollowPath,
        async canFollowPath(request): Promise<boolean> {
            return await resolveFollowPath(request) !== null;
        },
        async revokeScope(scopeInput): Promise<void> {
            const scope = normalizeTranscriptFileFollowGrantScope(scopeInput);
            const hasExecutionScopeFilter = scopeInput.scope !== undefined && scopeInput.scope !== null;
            for (const grant of grantsById.values()) {
                if (
                    grant.pluginId === scope.pluginId
                    && grant.runtimeId === scope.runtimeId
                    && (!hasExecutionScopeFilter || grant.scopeKey === scope.scopeKey)
                ) {
                    if ('close' in grant) await grant.close();
                    else grantsById.delete(grant.id);
                }
            }
        },
    });
}

async function resolvePendingTranscriptPath(path: string): Promise<string | null> {
    try {
        await lstat(path);
        return null;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const missingSegments = [basename(path)];
    let ancestor = dirname(path);
    while (true) {
        const realAncestor = await resolveTranscriptFileFollowRealPath(ancestor);
        if (realAncestor) return join(realAncestor, ...missingSegments);
        try {
            await lstat(ancestor);
            return null;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        }
        const parent = dirname(ancestor);
        if (parent === ancestor) return null;
        missingSegments.unshift(basename(ancestor));
        ancestor = parent;
    }
}

export function normalizeTranscriptFileFollowAbsolutePath(path: string): string | null {
    const trimmed = path.trim();
    if (!trimmed || /[\0\r\n]/.test(trimmed) || !isAbsolute(trimmed)) {
        return null;
    }
    return resolve(trimmed);
}

export function isTranscriptFileFollowPathInsideRoot(path: string, root: string): boolean {
    return isCanonicalAbsolutePathInsideRoot(root, path);
}

export async function resolveTranscriptFileFollowRealPath(path: string): Promise<string | null> {
    try {
        return await realpath(path);
    } catch {
        return null;
    }
}

function normalizeTranscriptFileFollowGrantScope(
    input: TranscriptFileFollowPathGrantScope,
): Readonly<{ pluginId: string; runtimeId: string; scopeKey: string | null }> {
    const pluginId = input.pluginId.trim();
    const runtimeId = input.runtimeId.trim();
    const scopeKey = normalizeExecutionScopeKey(input.scope);
    if (!pluginId || !runtimeId) {
        throw new PluginContextServiceError(
            'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
            'Transcript file-follow grants require plugin and runtime scope',
        );
    }
    return Object.freeze({ pluginId, runtimeId, scopeKey });
}

function normalizeExecutionScopeKey(scope: PluginExecutionScopeV1 | null | undefined): string | null {
    if (!scope) return null;
    return scope.kind === 'session'
        ? `session:${scope.sessionId}`
        : `execution_run:${scope.executionRunId}`;
}

function normalizeGrantExpiresAtMs(value: number | undefined): number | null {
    if (value === undefined) {
        return null;
    }
    if (!Number.isFinite(value) || value <= 0) {
        throw new PluginContextServiceError(
            'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
            'Transcript file-follow grant expiry must be a positive timestamp',
        );
    }
    return Math.trunc(value);
}
