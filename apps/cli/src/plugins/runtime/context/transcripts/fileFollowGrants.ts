import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import { PluginContextServiceError } from '../errors';

export type TranscriptFileFollowPathGrantReason =
    | 'providerTranscriptSource'
    | 'externalSessionTranscript'
    | 'testFixture';

export type TranscriptFileFollowPathGrantEvidence =
    | Readonly<{ kind: 'sessionStartTranscriptPath'; providerSessionId?: string }>
    | Readonly<{ kind: 'hostMaterializedTranscriptPath'; sourceId?: string }>
    | Readonly<{ kind: 'testOnly' }>;

export type TranscriptFileFollowPathGrantScope = Readonly<{
    pluginId: string;
    runtimeId: string;
    sessionId?: string | null;
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
    resolveFollowPath(
        request: TranscriptFileFollowPathGrantAuthorizeRequest,
    ): Promise<TranscriptFileFollowPathGrantResolution | null>;
    canFollowPath(request: TranscriptFileFollowPathGrantAuthorizeRequest): Promise<boolean>;
    revokeScope(scope: TranscriptFileFollowPathGrantScope): Promise<void>;
}>;

type StoredTranscriptFileFollowPathGrant = Readonly<{
    id: string;
    pluginId: string;
    runtimeId: string;
    sessionId: string | null;
    realPath: string;
    reason: TranscriptFileFollowPathGrantReason;
    evidence: TranscriptFileFollowPathGrantEvidence;
    expiresAtMs: number | null;
}>;

export function createTranscriptFileFollowPathGrantRegistry(): TranscriptFileFollowPathGrantRegistry {
    const grantsById = new Map<string, StoredTranscriptFileFollowPathGrant>();

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
        if (!realPath) {
            return null;
        }
        const now = Date.now();
        for (const grant of grantsById.values()) {
            if (grant.expiresAtMs !== null && grant.expiresAtMs <= now) {
                grantsById.delete(grant.id);
                continue;
            }
            if (
                grant.pluginId === scope.pluginId
                && grant.runtimeId === scope.runtimeId
                && grant.sessionId === scope.sessionId
                && grant.realPath === realPath
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
        async grant(input): Promise<TranscriptFileFollowPathGrantHandle> {
            const scope = normalizeTranscriptFileFollowGrantScope(input);
            const normalizedPath = normalizeTranscriptFileFollowAbsolutePath(input.path);
            if (!normalizedPath) {
                throw new PluginContextServiceError(
                    'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
                    'Transcript file-follow grants require an absolute transcript path',
                );
            }
            const realPath = await resolveTranscriptFileFollowRealPath(normalizedPath);
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
            const hasSessionFilter = normalizeOptionalScopeId(scopeInput.sessionId) !== null;
            for (const grant of grantsById.values()) {
                if (
                    grant.pluginId === scope.pluginId
                    && grant.runtimeId === scope.runtimeId
                    && (!hasSessionFilter || grant.sessionId === scope.sessionId)
                ) {
                    grantsById.delete(grant.id);
                }
            }
        },
    });
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
): Readonly<{ pluginId: string; runtimeId: string; sessionId: string | null }> {
    const pluginId = input.pluginId.trim();
    const runtimeId = input.runtimeId.trim();
    const sessionId = normalizeOptionalScopeId(input.sessionId);
    if (!pluginId || !runtimeId) {
        throw new PluginContextServiceError(
            'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_GRANT_INVALID',
            'Transcript file-follow grants require plugin and runtime scope',
        );
    }
    return Object.freeze({ pluginId, runtimeId, sessionId });
}

function normalizeOptionalScopeId(value: string | null | undefined): string | null {
    if (value === undefined || value === null) {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
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
