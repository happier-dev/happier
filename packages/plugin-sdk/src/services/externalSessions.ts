/** @moduleRealm daemon */
import type {
    ExternalSessionAgentId as ProtocolExternalSessionAgentId,
    ExternalSessionMaterializeActionResultV1,
    ExternalSessionOperationActionResultV1,
    ExternalSessionOperationReferenceV1,
    ExternalSessionOperationSharedPresentationV1,
    ExternalSessionRef as ProtocolExternalSessionRef,
    ExternalSessionSourceId as ProtocolExternalSessionSourceId,
} from '@happier-dev/protocol';

import type { PluginOperationAvailability } from '../availability.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue } from '../identity.js';
import type { Disposable, PluginCancellationOptions } from '../lifecycle.js';

export { ExternalSessionAgentIdSchema } from '@happier-dev/protocol';

export type ExternalSessionAgentId = ProtocolExternalSessionAgentId;
export type ExternalSessionSourceId = ProtocolExternalSessionSourceId;
export type ExternalSessionRef = ProtocolExternalSessionRef;

export type ExternalSessionsCapabilities = Readonly<{
    list: PluginOperationAvailability;
    attach: PluginOperationAvailability;
    takeover: ExternalSessionTakeoverCapability;
    transcript: PluginOperationAvailability;
    follow: PluginOperationAvailability;
}>;

export type ExternalSessionListQuery = Readonly<{
    agentId?: ExternalSessionAgentId;
    sourceId?: ExternalSessionSourceId;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
}>;

export type ExternalSessionCandidateRecord = Readonly<{
    ref: ExternalSessionRef;
    title?: string;
    updatedAtMs?: number;
    capabilities: readonly ('attach' | 'transcript' | 'follow')[];
    takeover: ExternalSessionTakeoverCapability;
}>;

export type ExternalSessionTakeoverCapability =
    | Readonly<{ status: 'unavailable'; code: string }>
    | Readonly<{
        status: 'available';
        storageModes: readonly ('external-linked' | 'persisted')[];
    }>;

export type ExternalSessionListPage = Readonly<{
    items: readonly ExternalSessionCandidateRecord[];
    nextCursor: string | null;
    diagnostics?: readonly PluginDiagnosticData[];
}>;

export type ExternalSessionTranscriptQuery =
    | Readonly<{
        mode: 'page';
        cursor?: string;
        direction: 'older' | 'newer';
        limit?: number;
        maxBytes?: number;
    }>
    | Readonly<{
        mode: 'readAfter';
        cursor: string;
        limit?: number;
        maxBytes?: number;
    }>;

/**
 * One transcript item delivered to a consuming plugin. `data` is the
 * recipient-safe projection of the producing Agent contribution's
 * `AgentExternalSessionTranscriptItem.raw` record: the field is deliberately
 * named `data` and typed as plain JSON because projection is free to omit
 * host-private facts, so it promises JSON shape rather than the producer's
 * transcript-record contract. Reading `.raw` off this item yields `undefined`;
 * the record contract lives on the Agent-direction producer facet.
 */
export type ExternalSessionTranscriptItem = Readonly<{
    id: string;
    timestampMs?: number;
    kind: 'user' | 'agent' | 'system' | 'event';
    data: JsonValue;
}>;

export type ExternalSessionReadAfterDiagnostic = Readonly<{
    code: string;
    count: number;
    positions: readonly number[];
}>;

export type ExternalSessionTranscriptReadResult =
    | Readonly<{
        mode: 'page';
        items: readonly ExternalSessionTranscriptItem[];
        nextCursor: string | null;
        tailCursor?: string | null;
        hasMore?: boolean;
        truncated?: boolean;
    }>
    | Readonly<{ mode: 'readAfter'; outcome: 'already_current' }>
    | Readonly<{
        mode: 'readAfter';
        outcome: 'advanced';
        items: readonly ExternalSessionTranscriptItem[];
        nextCursor: string;
        boundary: string;
        diagnostics?: readonly ExternalSessionReadAfterDiagnostic[];
    }>
    | Readonly<{
        mode: 'readAfter';
        outcome:
            | 'gap_or_cursor_expired'
            | 'source_replaced'
            | 'source_unavailable'
            | 'read_failed';
    }>;

export type ExternalSessionTranscriptFollowOptions =
    PluginCancellationOptions & Readonly<{ cursor?: string }>;

export type ExternalSessionTranscriptFollowEvent =
    | Readonly<{
        kind: 'data';
        items: readonly ExternalSessionTranscriptItem[];
        fromCursor: string | null;
        nextCursor: string;
    }>
    | Readonly<{
        kind: 'resyncRequired';
        reason: 'cursorDiscontinuity';
        cursor: string | null;
    }>
    | Readonly<{
        kind: 'terminated';
        reason:
            | 'disposed'
            | 'aborted'
            | 'retired'
            | 'providerFailure'
            | 'resyncRequired';
        cursor: string | null;
        code?: string;
    }>;

export type ExternalSessionTranscriptListener = (
    event: ExternalSessionTranscriptFollowEvent,
) => void | Promise<void>;

export type ExternalSessionTranscriptFollowResult =
    | Readonly<{
        status: 'following';
        startingCursor: string | null;
        subscription: Disposable;
    }>
    | Readonly<{ status: 'unavailable'; code: string }>;

export type ExternalSessionAttachResult = Readonly<{ sessionId: string }>;
export type ExternalSessionTakeoverIdempotencyKey = string;
export type ExternalSessionTakeoverRequest = Readonly<{
    targetStorageMode: 'external-linked' | 'persisted';
    idempotencyKey: ExternalSessionTakeoverIdempotencyKey;
}>;

export type ExternalSessionOperationReference =
    ExternalSessionOperationReferenceV1;
export type ExternalSessionOperationPresentation =
    ExternalSessionOperationSharedPresentationV1;
export type ExternalSessionMaterializeActionResult =
    ExternalSessionMaterializeActionResultV1;
export type ExternalSessionOperationActionResult =
    ExternalSessionOperationActionResultV1;

export interface ExternalSessionsService {
    capabilities(
        options?: PluginCancellationOptions,
    ): Promise<ExternalSessionsCapabilities>;
    list(
        query?: ExternalSessionListQuery,
        options?: PluginCancellationOptions,
    ): Promise<ExternalSessionListPage>;
    attach(
        ref: ExternalSessionRef,
        options?: PluginCancellationOptions,
    ): Promise<ExternalSessionAttachResult>;
    readTranscript(
        ref: ExternalSessionRef,
        query: ExternalSessionTranscriptQuery,
        options?: PluginCancellationOptions,
    ): Promise<ExternalSessionTranscriptReadResult>;
    followTranscript(
        ref: ExternalSessionRef,
        options: ExternalSessionTranscriptFollowOptions,
        listener: ExternalSessionTranscriptListener,
    ): Promise<ExternalSessionTranscriptFollowResult>;
    takeover(
        ref: ExternalSessionRef,
        request: ExternalSessionTakeoverRequest,
        options?: PluginCancellationOptions,
    ): Promise<ExternalSessionOperationReference>;
}
