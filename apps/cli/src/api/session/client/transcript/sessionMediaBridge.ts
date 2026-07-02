import { basename } from 'node:path';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import {
    persistSessionMedia,
    type PersistSessionMediaResult,
    type SessionMediaProviderFileDownloadResult,
} from '@/session/media/persistSessionMedia';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import type { GarbageCollectSessionMediaResult } from '@/session/media/budget';
import {
    inferSessionMediaMimeTypeFromName,
    normalizeSessionMediaMimeType,
} from '@/session/media/mime';
import {
    isUnsafeSessionMediaMetadataString,
    sanitizeSessionMediaIdentifier,
} from '@/session/media/names';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { SessionMediaFailureV1 } from '@happier-dev/protocol';
import type {
    SessionMediaIngestionSource,
    SessionMediaItemV1,
    SessionMediaOrigin,
} from '@/session/media/_types';

export type SessionMediaBridgeInput = Readonly<{
    source: SessionMediaIngestionSource;
    origin: SessionMediaOrigin;
    suggestedName?: string;
    createdAtMs?: number;
    sourceAccessPolicy?: FilesystemAccessPolicy;
    accessPolicy?: FilesystemAccessPolicy;
}>;

export type SendAgentSessionMediaCommittedRequest = Readonly<{
    localId: string;
    role: 'input' | 'output';
    category: 'attachment' | 'generated' | 'tool-artifact';
    media: readonly SessionMediaBridgeInput[];
    meta?: Record<string, unknown>;
    messageText?: string;
}>;

type LoggerLike = Readonly<{
    debug: (message: string, details?: unknown) => void;
}>;

export type SessionMediaBridgePersistDeps = Readonly<{
    sessionId: string;
    workingDirectory?: string | null;
    request: SendAgentSessionMediaCommittedRequest;
    providerFileDownloader?: (source: Extract<SessionMediaIngestionSource, { kind: 'provider-file' }>) => Promise<SessionMediaProviderFileDownloadResult>;
    logger?: LoggerLike;
}>;

export type SessionMediaBridgePersistResult =
    Readonly<{
        success: boolean;
        items: readonly SessionMediaItemV1[];
        createdWorkspaceRelativePaths: readonly string[];
        failures: readonly SessionMediaFailureV1[];
        meta: Record<string, unknown>;
    }>;

export async function garbageCollectFailedSessionMediaCommit(params: Readonly<{
    workingDirectory: string;
    persisted: SessionMediaBridgePersistResult;
    logger?: LoggerLike;
}>): Promise<GarbageCollectSessionMediaResult | null> {
    if (params.persisted.createdWorkspaceRelativePaths.length === 0) {
        return { deletedFiles: 0, deletedBytes: 0 };
    }
    return await garbageCollectUncommittedSessionMedia({
        workingDirectory: params.workingDirectory,
        candidateWorkspaceRelativePaths: params.persisted.createdWorkspaceRelativePaths,
        reason: 'failed_durable_write',
        logger: params.logger,
    });
}

const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
const MAX_SAFE_FAILURE_NAME_LENGTH = 120;

const UNSAFE_META_KEYS = new Set([
    'data',
    'base64',
    'b64',
    'b64_json',
    'inlineData',
    'url',
    'uri',
    'fileUrl',
    'backendId',
    'provider',
    'providerId',
    'providerFileId',
    'providerEventId',
    'agentId',
    'summary',
    'summaryPreview',
    'providerSummary',
    'sourcePath',
    'path',
    'prompt',
    'revisedPrompt',
    'revised_prompt',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUnsafeString(value: string): boolean {
    return isUnsafeSessionMediaMetadataString(value);
}

function sanitizeBridgeMetaValue(value: unknown): unknown {
    if (typeof value === 'string') {
        return isUnsafeString(value) ? undefined : value;
    }
    if (Array.isArray(value)) {
        const items = value
            .map((item) => sanitizeBridgeMetaValue(item))
            .filter((item) => item !== undefined);
        return items.length > 0 ? items : undefined;
    }
    if (!isRecord(value)) {
        return value;
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        if (UNSAFE_META_KEYS.has(key)) continue;
        const next = sanitizeBridgeMetaValue(child);
        if (next !== undefined) {
            sanitized[key] = next;
        }
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeBridgeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!meta) return {};
    const sanitized = sanitizeBridgeMetaValue(meta);
    return isRecord(sanitized) ? sanitized : {};
}

function sanitizeOrigin(origin: SessionMediaOrigin): SessionMediaOrigin {
    const agentId = sanitizeSessionMediaIdentifier(origin.agentId);
    const toolCallId = sanitizeSessionMediaIdentifier(origin.toolCallId);
    const generationId = sanitizeSessionMediaIdentifier(origin.generationId);
    const providerEventId = sanitizeSessionMediaIdentifier(origin.providerEventId);
    const providerFileId = sanitizeSessionMediaIdentifier(origin.providerFileId);
    return {
        source: origin.source,
        ...(agentId ? { agentId } : {}),
        ...(toolCallId ? { toolCallId } : {}),
        ...(generationId ? { generationId } : {}),
        ...(providerEventId ? { providerEventId } : {}),
        ...(providerFileId ? { providerFileId } : {}),
    };
}

function sanitizeMediaItem(item: SessionMediaItemV1): SessionMediaItemV1 {
    return {
        ...item,
        origin: sanitizeOrigin(item.origin),
    };
}

function requiresScopedSourceAccessPolicy(source: SessionMediaIngestionSource): boolean {
    return source.kind === 'local-file' || source.kind === 'local-uri';
}

function hasRestrictedRootsAccessPolicy(
    accessPolicy: FilesystemAccessPolicy | undefined,
): accessPolicy is Extract<FilesystemAccessPolicy, { kind: 'restrictedRoots' }> {
    return accessPolicy?.kind === 'restrictedRoots' && accessPolicy.roots.length > 0;
}

function buildFailure(
    request: SendAgentSessionMediaCommittedRequest,
    entry: SessionMediaBridgeInput,
    index: number,
    result: Extract<PersistSessionMediaResult, { success: false }> | Readonly<{ code: string }>,
): SessionMediaFailureV1 {
    const name = resolveFailureName(entry, index);
    const mimeType = normalizeSessionMediaMimeType(readSourceMimeType(entry.source))
        ?? inferSessionMediaMimeTypeFromName(name)
        ?? undefined;
    return {
        index,
        code: result.code,
        role: request.role,
        category: request.category,
        mediaKind: 'image',
        name,
        ...(mimeType ? { mimeType } : {}),
        ...(typeof entry.createdAtMs === 'number' ? { createdAtMs: entry.createdAtMs } : {}),
        origin: sanitizeOrigin(entry.origin),
    };
}

function readSourceMimeType(source: SessionMediaIngestionSource): string | undefined {
    return 'mimeType' in source && typeof source.mimeType === 'string' ? source.mimeType : undefined;
}

function readSourceNameHint(source: SessionMediaIngestionSource): string | undefined {
    return 'fileNameHint' in source && typeof source.fileNameHint === 'string' ? source.fileNameHint : undefined;
}

function sanitizeFailureName(value: string, fallback: string): string {
    if (isUnsafeFailureNameCandidate(value)) return fallback;
    const baseName = basename(value).trim();
    if (isUnsafeFailureNameCandidate(baseName)) return fallback;
    const normalized = baseName.replace(/[^\w.\- ()]/g, '_').replace(/_+/g, '_');
    if (
        !normalized
        || normalized === '.'
        || normalized === '..'
        || normalized.length > MAX_SAFE_FAILURE_NAME_LENGTH
    ) {
        return fallback;
    }
    return normalized;
}

function isUnsafeFailureNameCandidate(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return true;
    if (trimmed.length > MAX_SAFE_FAILURE_NAME_LENGTH) return true;
    if (/^(?:data|file|https?|blob):/iu.test(trimmed)) return true;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) return true;
    if (trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-z]:[\\/]/iu.test(trimmed)) return true;
    if (isBase64LikeFailureName(trimmed)) return true;
    return false;
}

function isBase64LikeFailureName(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length < 11) return false;
    if (trimmed.includes('.') || /\s/u.test(trimmed)) return false;
    if (!/[A-Z]/u.test(trimmed) || !/[a-z]/u.test(trimmed) || !/[0-9+/_=-]/u.test(trimmed)) return false;
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(trimmed)) return false;
    const unpadded = trimmed.replace(/=+$/u, '');
    const normalized = unpadded.replace(/-/gu, '+').replace(/_/gu, '/');
    if (normalized.length % 4 === 1) return false;
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    try {
        const decoded = Buffer.from(padded, 'base64');
        if (decoded.byteLength < 8) return false;
        return decoded.toString('base64').replace(/=+$/u, '') === normalized;
    } catch {
        return false;
    }
}

function resolveFailureName(entry: SessionMediaBridgeInput, index: number): string {
    const fallback = `image-${index + 1}`;
    if (entry.suggestedName) return sanitizeFailureName(entry.suggestedName, fallback);
    const sourceNameHint = readSourceNameHint(entry.source);
    if (sourceNameHint) return sanitizeFailureName(sourceNameHint, fallback);
    if (entry.source.kind === 'local-file') return sanitizeFailureName(entry.source.path, fallback);
    if (entry.source.kind === 'local-uri') return sanitizeFailureName(entry.source.uri, fallback);
    return fallback;
}

function buildSessionMediaMeta(
    items: readonly SessionMediaItemV1[],
    failures: readonly SessionMediaFailureV1[],
): Record<string, unknown> {
    return {
        kind: 'session_media.v1',
        payload: {
            media: items,
            ...(failures.length > 0 ? { failures } : {}),
        },
    };
}

function attachSessionMediaMeta(
    meta: Record<string, unknown>,
    items: readonly SessionMediaItemV1[],
    failures: readonly SessionMediaFailureV1[],
): Record<string, unknown> {
    if (items.length === 0 && failures.length === 0) return meta;
    const sessionMediaMeta = buildSessionMediaMeta(items, failures);
    if (Object.prototype.hasOwnProperty.call(meta, 'happier')) {
        return { ...meta, happierMedia: sessionMediaMeta };
    }
    return { ...meta, happier: sessionMediaMeta };
}

export async function persistSessionMediaForTranscript(
    deps: SessionMediaBridgePersistDeps,
): Promise<SessionMediaBridgePersistResult> {
    const items: SessionMediaItemV1[] = [];
    const createdWorkspaceRelativePaths: string[] = [];
    const failures: SessionMediaFailureV1[] = [];
    const workingDirectory = typeof deps.workingDirectory === 'string' && deps.workingDirectory.trim().length > 0
        ? deps.workingDirectory
        : null;

    try {
        for (let index = 0; index < deps.request.media.length; index += 1) {
            const entry = deps.request.media[index]!;
            if (!workingDirectory) {
                failures.push(buildFailure(deps.request, entry, index, { code: 'missing_working_directory' }));
                continue;
            }
            if (requiresScopedSourceAccessPolicy(entry.source) && !hasRestrictedRootsAccessPolicy(entry.sourceAccessPolicy)) {
                failures.push(buildFailure(deps.request, entry, index, { code: 'scoped_media_access_policy_required' }));
                continue;
            }
            const result = await persistSessionMedia({
                workingDirectory,
                pathAllowanceRegistry,
                providerFileDownloader: deps.providerFileDownloader,
                ...(entry.accessPolicy ? { accessPolicy: entry.accessPolicy } : {}),
                ...(entry.sourceAccessPolicy ? { sourceAccessPolicy: entry.sourceAccessPolicy } : {}),
                input: {
                    sessionId: deps.sessionId,
                    messageLocalId: deps.request.localId,
                    role: deps.request.role,
                    category: deps.request.category,
                    source: entry.source,
                    origin: entry.origin,
                    ...(entry.suggestedName ? { suggestedName: entry.suggestedName } : {}),
                    ...(typeof entry.createdAtMs === 'number' ? { createdAtMs: entry.createdAtMs } : {}),
                },
            });
            if (result.success) {
                items.push(sanitizeMediaItem(result.item));
                if (result.created) {
                    createdWorkspaceRelativePaths.push(result.item.path);
                }
            } else {
                failures.push(buildFailure(deps.request, entry, index, result));
            }
        }
    } catch (error) {
        if (workingDirectory && createdWorkspaceRelativePaths.length > 0) {
            await garbageCollectUncommittedSessionMedia({
                workingDirectory,
                candidateWorkspaceRelativePaths: createdWorkspaceRelativePaths,
                reason: 'interrupted_ingestion',
                logger: deps.logger,
            });
        }
        throw error;
    }

    const meta = attachSessionMediaMeta(sanitizeBridgeMeta(deps.request.meta), items, failures);

    return {
        success: failures.length === 0,
        items,
        createdWorkspaceRelativePaths,
        failures,
        meta,
    };
}
