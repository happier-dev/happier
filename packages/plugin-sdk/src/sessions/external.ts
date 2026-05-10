import type {
    ExternalSessionCandidateV1 as ProtocolExternalSessionCandidateV1,
    ExternalSessionsSource,
    ExternalSessionTranscriptPageResponse,
    ExternalSessionTranscriptRawMessageV1,
    ExternalSessionTranscriptReadAfterResponse,
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol';

import type { SubscriptionV1 } from '../context';

export type ExternalSessionSourceV1 = ExternalSessionsSource;
export type ExternalSessionCandidateV1 = ProtocolExternalSessionCandidateV1;
export type ExternalSessionTranscriptItemV1 = ExternalSessionTranscriptRawMessageV1;
export type ExternalSessionTranscriptPageResultV1 = ExternalSessionTranscriptPageResponse;
export type ExternalSessionTranscriptReadAfterResultV1 = ExternalSessionTranscriptReadAfterResponse;

// Canonical plugin SDK access is ctx.sessions.external.*; top-level
// namespaces remain intentionally absent during the wire-compat migration window.
export type ExternalSessionListCandidatesParamsV1 = Readonly<{
    providerId?: string;
    source?: ExternalSessionSourceV1;
    cursor?: string;
    limit?: number;
    searchTerm?: string;
}>;

export type ExternalSessionListCandidatesResultV1 = Readonly<{
    candidates: readonly ExternalSessionCandidateV1[];
    nextCursor: string | null;
}>;

export type ExternalSessionAttachParamsV1 = Readonly<{
    providerId: string;
    remoteSessionId: string;
    source?: ExternalSessionSourceV1;
    metadata?: Readonly<Record<string, unknown>>;
}>;

export type ExternalSessionAttachResultV1 = Readonly<{
    ok: boolean;
    sessionId?: string;
    error?: string;
}>;

export type ExternalSessionTranscriptPageParamsV1 = Readonly<{
    providerId: string;
    remoteSessionId: string;
    source: ExternalSessionSourceV1;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes?: number;
    maxItems?: number;
}>;

export type ExternalSessionTranscriptReadAfterParamsV1 = Readonly<{
    providerId: string;
    remoteSessionId: string;
    source: ExternalSessionSourceV1;
    cursor: string;
    maxBytes?: number;
    maxItems?: number;
}>;

export type ExternalSessionTranscriptUpdateV1 = Readonly<{
    items: readonly ExternalSessionTranscriptItemV1[];
    nextCursor?: string | null;
}>;

export interface PluginExternalSessionsServiceV1 {
    listCandidates(
        params?: ExternalSessionListCandidatesParamsV1,
    ): Promise<ExternalSessionListCandidatesResultV1>;
    attach(params: ExternalSessionAttachParamsV1): Promise<ExternalSessionAttachResultV1>;
    takeover(params: ExternalSessionTakeoverInputV1): Promise<ExternalSessionTakeoverResultV1>;
    pageTranscript(
        params: ExternalSessionTranscriptPageParamsV1,
    ): Promise<ExternalSessionTranscriptPageResultV1>;
    readAfterTranscript(
        params: ExternalSessionTranscriptReadAfterParamsV1,
    ): Promise<ExternalSessionTranscriptReadAfterResultV1>;
    followTranscript(
        params: ExternalSessionTranscriptReadAfterParamsV1,
        onEvent: (event: ExternalSessionTranscriptUpdateV1) => void,
    ): SubscriptionV1;
}

export type {
    ExternalSessionTakeoverInputV1,
    ExternalSessionTakeoverResultV1,
};
