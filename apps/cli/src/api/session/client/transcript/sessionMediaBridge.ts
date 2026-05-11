import { basename } from 'node:path';

import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import {
    persistSessionMedia,
    type PersistSessionMediaResult,
    type SessionMediaProviderFileDownloadResult,
} from '@/session/media/persistSessionMedia';
import {
    inferSessionMediaMimeTypeFromName,
    normalizeSessionMediaMimeType,
} from '@/session/media/mime';
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
}>;

export type SendAgentSessionMediaCommittedRequest = Readonly<{
    localId: string;
    role: 'input' | 'output';
    category: 'attachment' | 'generated' | 'tool-artifact';
    media: readonly SessionMediaBridgeInput[];
    meta?: Record<string, unknown>;
    messageText?: string;
}>;

export type SessionMediaBridgePersistDeps = Readonly<{
    sessionId: string;
    workingDirectory?: string | null;
    request: SendAgentSessionMediaCommittedRequest;
    providerFileDownloader?: (source: Extract<SessionMediaIngestionSource, { kind: 'provider-file' }>) => Promise<SessionMediaProviderFileDownloadResult>;
}>;

export type SessionMediaBridgePersistResult =
    Readonly<{
        success: boolean;
        items: readonly SessionMediaItemV1[];
        failures: readonly SessionMediaFailureV1[];
        meta: Record<string, unknown>;
    }>;

const pathAllowanceRegistry = createTransferPathAllowanceRegistry();

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
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isUnsafeString(value: string): boolean {
    const trimmed = value.trim();
    return (
        trimmed.startsWith('/')
        || trimmed.startsWith('\\')
        || /^[a-z]:[\\/]/i.test(trimmed)
        || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    );
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
    return {
        source: origin.source,
        ...(typeof origin.agentId === 'string' && origin.agentId.trim() ? { agentId: origin.agentId } : {}),
        ...(typeof origin.toolCallId === 'string' && origin.toolCallId.trim() ? { toolCallId: origin.toolCallId } : {}),
        ...(typeof origin.generationId === 'string' && origin.generationId.trim() ? { generationId: origin.generationId } : {}),
        ...(typeof origin.providerEventId === 'string' && origin.providerEventId.trim() ? { providerEventId: origin.providerEventId } : {}),
        ...(typeof origin.providerFileId === 'string' && origin.providerFileId.trim() ? { providerFileId: origin.providerFileId } : {}),
    };
}

function sanitizeMediaItem(item: SessionMediaItemV1): SessionMediaItemV1 {
    return {
        ...item,
        origin: sanitizeOrigin(item.origin),
    };
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
    const baseName = basename(value).trim();
    const normalized = baseName.replace(/[^\w.\- ()]/g, '_').replace(/_+/g, '_');
    if (!normalized || normalized === '.' || normalized === '..') return fallback;
    return normalized;
}

function resolveFailureName(entry: SessionMediaBridgeInput, index: number): string {
    const fallback = `media-${index + 1}`;
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

export async function persistSessionMediaForTranscript(
    deps: SessionMediaBridgePersistDeps,
): Promise<SessionMediaBridgePersistResult> {
    const items: SessionMediaItemV1[] = [];
    const failures: SessionMediaFailureV1[] = [];
    const workingDirectory = typeof deps.workingDirectory === 'string' && deps.workingDirectory.trim().length > 0
        ? deps.workingDirectory
        : null;

    for (let index = 0; index < deps.request.media.length; index += 1) {
        const entry = deps.request.media[index]!;
        if (!workingDirectory) {
            failures.push(buildFailure(deps.request, entry, index, { code: 'missing_working_directory' }));
            continue;
        }
        const result = await persistSessionMedia({
            workingDirectory,
            pathAllowanceRegistry,
            providerFileDownloader: deps.providerFileDownloader,
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
        } else {
            failures.push(buildFailure(deps.request, entry, index, result));
        }
    }

    const meta = {
        ...sanitizeBridgeMeta(deps.request.meta),
        ...(items.length > 0 || failures.length > 0 ? { happierMedia: buildSessionMediaMeta(items, failures) } : {}),
    };

    return {
        success: failures.length === 0,
        items,
        failures,
        meta,
    };
}
