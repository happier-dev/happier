/** @moduleRealm daemon */
import {
    AgentExternalSessionTranscriptRawRecordSchema as canonicalAgentExternalSessionTranscriptRawRecordSchema,
    HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1 as canonicalHappierBaseSystemPromptAttachmentsV1,
    HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1 as canonicalHappierBaseSystemPromptLinkedWorkspaceFilesV1,
    HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1 as canonicalHappierBaseSystemPromptOptionsV1,
    HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1 as canonicalHappierBaseSystemPromptSessionTitleInitialV1,
} from '@happier-dev/protocol';
import {
    isAgentExternalSessionsFailureCode,
    type AgentExternalSessionsFailureCode,
} from './sessions/external/failureCodes.js';

export const HAPPIER_BASE_SYSTEM_PROMPT_ATTACHMENTS_V1: string =
    canonicalHappierBaseSystemPromptAttachmentsV1;
export const HAPPIER_BASE_SYSTEM_PROMPT_LINKED_WORKSPACE_FILES_V1: string =
    canonicalHappierBaseSystemPromptLinkedWorkspaceFilesV1;
export const HAPPIER_BASE_SYSTEM_PROMPT_OPTIONS_V1: string =
    canonicalHappierBaseSystemPromptOptionsV1;
export const HAPPIER_BASE_SYSTEM_PROMPT_SESSION_TITLE_INITIAL_V1: string =
    canonicalHappierBaseSystemPromptSessionTitleInitialV1;

import type { ManagedServiceSpec } from './managed-services/contract.js';
import type { ExecService } from './exec.js';
import type { JsonValue } from './identity.js';
import type { SessionMessageRole, SessionSchema } from './services/sessions.js';

/**
 * Public author shape for one admitted External Session transcript record.
 * Protocol remains the runtime validator; the SDK owns its structural author
 * declaration so external plugins do not acquire a private Protocol type edge.
 */
export type AgentExternalSessionTranscriptRawRecord =
    | Readonly<{
        role: 'user';
        content: Readonly<{ type: 'text'; text: string }>;
    }>
    | Readonly<{
        role: 'agent';
        content: JsonValue;
    }>;

/** Portable JSON fact retained by one External Session source link. */
export type AgentExternalSessionLinkDataValue =
    | null
    | boolean
    | number
    | string
    | readonly AgentExternalSessionLinkDataValue[]
    | Readonly<{ readonly [key: string]: AgentExternalSessionLinkDataValue }>;

/** Opaque source-link data accepted and normalized by the canonical Protocol parser. */
export type AgentExternalSessionLinkData = Readonly<{
    readonly [key: string]: AgentExternalSessionLinkDataValue;
}>;

/** Source provenance admitted only for eligible user transcript rows. */
export type AgentExternalSessionUserProjection =
    | 'source_fact'
    | 'terminal_origin'
    | 'host_prompt_echo';

/** The Protocol parser remains the sole runtime admission owner. */
export const AgentExternalSessionTranscriptRawRecordSchema: SessionSchema<
    AgentExternalSessionTranscriptRawRecord
> = canonicalAgentExternalSessionTranscriptRawRecordSchema;

export { isAgentExternalSessionsFailureCode };
export type { AgentExternalSessionsFailureCode };

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

export type AgentExternalSessionsManagedEndpointReadRequest = Readonly<{
    pathAndQuery: string;
    headers?: Readonly<Record<string, string>>;
}>;

export type AgentExternalSessionsManagedEndpointReadResponse = Readonly<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: Readonly<Record<string, string>>;
    body: ReadableStream<Uint8Array> | null;
}>;

export type AgentExternalSessionsManagedEndpointRead = (
    request: AgentExternalSessionsManagedEndpointReadRequest,
) => Promise<AgentExternalSessionsManagedEndpointReadResponse>;

/**
 * Bounds supplied by the host for one contribution call. The contribution must
 * settle before the absolute deadline, observe the signal, and keep its complete
 * serialized result within `maxSerializedBytes`.
 */
export type AgentExternalSessionsInvocationBounds = Readonly<{
    signal: AbortSignal;
    deadlineAtMs: number;
    maxSerializedBytes: number;
}>;

export type AgentExternalSessionsInvocation =
    AgentExternalSessionsInvocationBounds & Readonly<{
        /**
         * Host-stamped for every generation-bound auxiliary call. Isolated
         * harnesses must supply a fail-closed callback when no endpoint exists.
         */
        managedEndpointRead: AgentExternalSessionsManagedEndpointRead;
        /**
         * Host-stamped execution authority for this generation-bound call.
         * It uses the same manifest-declared process/tool grants and lifecycle
         * fencing as every other Agent invocation.
         */
        exec: ExecService;
    }>;

export type AgentExternalSessionCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    createdAtMs?: number;
    archived?: boolean;
    linkData?: AgentExternalSessionLinkData;
}>;

/**
 * Host-derived origin classification for a user transcript row eligible for
 * terminal follow. It is producer-to-host metadata, never an assertion from a
 * recipient-facing transcript reader or a substitute for raw-envelope role.
 */
/**
 * One transcript item produced by an Agent contribution. `raw` carries the
 * canonical transcript record; source-derived role and identity metadata stay
 * beside it rather than inside it, so `raw` never has to be loosened to carry
 * routing facts.
 *
 * This is the Agent-direction producer facet. The consumer facet an ordinary
 * plugin receives from `SessionsService.external.readTranscript` is
 * `ExternalSessionTranscriptItem`, whose recipient-safe projection of this
 * record is named `data`, not `raw`.
 */
export type AgentExternalSessionTranscriptItem = Readonly<{
    id: string;
    createdAtMs: number;
    localId?: string | null;
    sidechainId?: string | null;
    messageRole?: SessionMessageRole | null;
    userProjection?: AgentExternalSessionUserProjection;
    raw: AgentExternalSessionTranscriptRawRecord;
}>;

export type AgentExternalSessionsResolveSourceRequest = AgentExternalSessionsInvocation & Readonly<{
    source: AgentExternalSessionSource;
}>;
export type AgentExternalSessionsResolveSourceResult = Readonly<{
    source: AgentExternalSessionSource;
    /**
     * Transient, source-owned absolute directories for media paths emitted by
     * this source. The host validates this evidence at admission and must not
     * copy it into persisted link data or transcript records.
     */
    transcriptMediaReadRoots?: readonly string[];
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
    /**
     * Transient, source-owned absolute directories for media paths emitted by
     * this resolved identity. The host validates this evidence at admission
     * and must not copy it into persisted link data or transcript records.
     */
    transcriptMediaReadRoots?: readonly string[];
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
    ): AgentExternalSessionsResult<AgentExternalSessionsResolveSourceResult>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsResolveSourceResult>>;
    listCandidates(
        request: AgentExternalSessionsListCandidatesRequest,
    ): AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsListCandidatesResult>>;
    resolveLinkIdentity(
        request: AgentExternalSessionsResolveLinkIdentityRequest,
    ): AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>>;
    resolveLinkedIdentity(
        request: AgentExternalSessionsResolveLinkedIdentityRequest,
    ): AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsResolvedIdentity>>;
    pageTranscript(
        request: AgentExternalSessionsPageTranscriptRequest,
    ): AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsTranscriptPage>>;
    readAfterTranscript(
        request: AgentExternalSessionsReadAfterTranscriptRequest,
    ): AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult>
        | Promise<AgentExternalSessionsResult<AgentExternalSessionsReadAfterTranscriptResult>>;
    /**
     * Declares the managed service that serves this source's managed endpoint
     * when the contribution owns one, so a read does not depend on a live
     * Session runner happening to have started the same server.
     *
     * This is a declaration, not a capability: the contribution returns a
     * specification and never receives `ManagedServices`, a handle, or a base
     * URL. The host owns admission, credential minting, supervision, reuse and
     * teardown, and refuses a spawn whose client access is not host-minted.
     * Return `null` for a source the contribution reaches directly.
     */
    resolveManagedEndpointService?(
        request: AgentExternalSessionsManagedEndpointServiceRequest,
    ): Promise<ManagedServiceSpec | null> | ManagedServiceSpec | null;
}>;

export type AgentExternalSessionsManagedEndpointServiceRequest = Readonly<{
    source: AgentExternalSessionSource;
    signal: AbortSignal;
}>;
