import type {
    PluginAgentExternalSessionLinkData,
    PluginAgentExternalSessionLinkDataValue,
    SessionMessageRole,
} from '@happier-dev/protocol';

type MaybePromise<T> = T | Promise<T>;

export type AgentExternalSessionLinkDataValue = PluginAgentExternalSessionLinkDataValue;
export type AgentExternalSessionLinkData = PluginAgentExternalSessionLinkData;

export type AgentExternalSessionsFailureCode =
    | 'source_invalid'
    | 'source_unreachable'
    | 'candidate_not_found'
    | 'agent_unavailable'
    | 'unsupported'
    | 'unavailable'
    | 'not_authorized'
    | 'invalid_request'
    | 'cancelled'
    | 'agent_error'
    | 'timeout';

export type AgentExternalSessionsResult<T> =
    | Readonly<{ ok: true; value: T }>
    | Readonly<{
        ok: false;
        code: AgentExternalSessionsFailureCode;
        message?: string;
        retryable?: boolean;
    }>;

export type AgentExternalSessionSource = Readonly<{
    kind: string;
} & Record<string, AgentExternalSessionLinkDataValue>>;

/**
 * Bounds supplied by the host for one contribution call. The contribution must
 * settle before the absolute deadline, observe the signal, and keep its complete
 * serialized result within `maxSerializedBytes`.
 */
export type AgentExternalSessionsInvocation = Readonly<{
    signal: AbortSignal;
    deadlineAtMs: number;
    maxSerializedBytes: number;
}>;

export type AgentExternalSessionCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    createdAtMs?: number;
    archived?: boolean;
    linkData?: AgentExternalSessionLinkData;
}>;

export type AgentExternalSessionTranscriptItem = Readonly<{
    id: string;
    createdAtMs: number;
    localId?: string | null;
    messageRole?: SessionMessageRole | null;
    raw: AgentExternalSessionLinkData;
}>;

export type AgentExternalSessionsResolveSourceRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
}>;
export type AgentExternalSessionsResolveSourceResult = Readonly<{
    source: AgentExternalSessionSource;
}>;

export type AgentExternalSessionsListCandidatesRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
    cursor?: string;
    maxItems: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
}>;
export type AgentExternalSessionsCandidatePreparation = Readonly<{
    kind: 'building_candidate_index';
    scanned: number;
    total?: number;
}>;
export type AgentExternalSessionsListCandidatesResult = Readonly<{
    candidates: readonly AgentExternalSessionCandidate[];
    nextCursor: string | null;
    searchIncomplete?: boolean;
    preparation?: AgentExternalSessionsCandidatePreparation;
}>;

export type AgentExternalSessionsResolveLinkIdentityRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    linkData?: AgentExternalSessionLinkData;
}>;
export type AgentExternalSessionsResolveLinkedIdentityRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    linkData: AgentExternalSessionLinkData;
}>;
export type AgentExternalSessionsResolvedIdentity = Readonly<{
    /**
     * Fully resolved source for all transcript calls. The host persists
     * `linkData`, feeds it back through `resolveLinkedIdentity` after reload,
     * and then forwards this returned source rather than passing two
     * independently authoritative candidate identities to transcript methods.
     */
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    linkData: AgentExternalSessionLinkData;
}>;

export type AgentExternalSessionsPageTranscriptRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxItems: number;
}>;
export type AgentExternalSessionsReadAfterTranscriptRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
    remoteSessionId: string;
    cursor: string;
    maxItems: number;
}>;
export type AgentExternalSessionsReadAfterDiagnostic = Readonly<{
    code: string;
    count: number;
    /**
     * Bounded source-local numeric positions (for example line numbers or byte
     * offsets). Raw source content and paths are never diagnostics.
     */
    positions: readonly number[];
}>;
export type AgentExternalSessionsReadAfterTranscriptResult =
    | Readonly<{ outcome: 'already_current' }>
    | Readonly<{
        outcome: 'advanced';
        items: readonly AgentExternalSessionTranscriptItem[];
        nextCursor: string;
        boundary: string;
        diagnostics?: readonly AgentExternalSessionsReadAfterDiagnostic[];
    }>
    | Readonly<{ outcome: 'gap_or_cursor_expired' }>
    | Readonly<{ outcome: 'source_replaced' }>
    | Readonly<{ outcome: 'source_unavailable' }>
    | Readonly<{ outcome: 'read_failed' }>;
export type AgentExternalSessionsTranscriptPage = Readonly<{
    items: readonly AgentExternalSessionTranscriptItem[];
    nextCursor: string | null;
    tailCursor?: string | null;
    hasMore?: boolean;
    truncated?: boolean;
}>;

/**
 * Public External Sessions auxiliary for one manifest-declared Agent local id.
 * Host policy, generation fencing, cancellation, deadline, and result bounds are
 * enforced by the canonical invocation owner; contributions must honor the same
 * explicit inputs and must not add lifecycle/control operations here.
 */
export type AgentExternalSessionsContribution = Readonly<{
    resolveSource(
        request: AgentExternalSessionsResolveSourceRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsResolveSourceResult>>;
    listCandidates(
        request: AgentExternalSessionsListCandidatesRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>>;
    resolveLinkIdentity(
        request: AgentExternalSessionsResolveLinkIdentityRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>>;
    resolveLinkedIdentity(
        request: AgentExternalSessionsResolveLinkedIdentityRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>>;
    pageTranscript(
        request: AgentExternalSessionsPageTranscriptRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>>;
    readAfterTranscript(
        request: AgentExternalSessionsReadAfterTranscriptRequest,
    ): MaybePromise<AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult>>;
}>;
