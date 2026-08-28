import type {
  Disposable,
  JsonValue,
  PluginDiagnosticData,
} from '@happier-dev/plugin-sdk';
import type {
  ExternalSessionAgentId,
  ExternalSessionRef,
  ExternalSessionSourceId,
  ExternalSessionsSource,
  ExternalSessionUserProjection,
} from '@happier-dev/protocol';
import type {
  PluginOperationAvailability } from '@happier-dev/plugin-sdk';
import type {
  SessionsService,
} from '@happier-dev/plugin-sdk/sessions';

export type HostExternalSessionRef = ExternalSessionRef;

export type HostExternalSessionCandidate = Readonly<{
  ref: HostExternalSessionRef;
  title?: string;
  updatedAtMs?: number;
  capabilities: readonly ('attach' | 'transcript' | 'follow')[];
}>;

export type HostExternalTranscriptItem = Readonly<{
  id: string;
  /** Provider-fact identity for durable transcript idempotency; `id` remains the paging identity. */
  localId?: string;
  /** Explicit provider classification; the terminal projector enforces phase-specific handling. */
  userProjection?: ExternalSessionUserProjection;
  timestampMs?: number;
  kind: 'user' | 'agent' | 'system' | 'event';
  data: JsonValue;
}>;

export type HostExternalTranscriptFollowEvent =
  | Readonly<{
      kind: 'data';
      phase?: 'initial_replay';
      items: readonly HostExternalTranscriptItem[];
      fromCursor: string | null;
      nextCursor: string;
    }>
  | Readonly<{
      kind: 'resyncRequired';
      reason: 'cursorDiscontinuity' | 'providerTruncated' | 'bufferOverflow';
      cursor: string | null;
    }>
  | Readonly<{
      kind: 'terminated';
      reason: 'disposed' | 'aborted' | 'retired' | 'providerFailure' | 'resyncRequired';
      cursor: string | null;
      code?: string;
    }>;

export type HostExternalTranscriptFollowResult =
  | Readonly<{
      status: 'following';
      startingCursor: string | null;
      subscription: Disposable;
      /**
       * Optional private lifecycle signal for follow owners whose work continues
       * after acquisition has returned. It resolves only for an unexpected
       * asynchronous failure; ordinary disposal and retirement leave it pending.
       */
      failure?: Promise<Error>;
    }>
  | Readonly<{
      status: 'unavailable';
      code: string;
    }>;

export type HostExternalSessionFollowTarget = Readonly<{
  ref: HostExternalSessionRef;
  source: ExternalSessionsSource;
}>;

export type HostExternalSessionFollowTargetResolution =
  | Readonly<HostExternalSessionFollowTarget & {
      status: 'resolved';
    }>
  | Readonly<{
      status: 'unavailable';
      code: string;
    }>;

export type HostExternalTranscriptReadQuery =
  | Readonly<{
      mode?: 'page';
      cursor?: string;
      direction?: 'older' | 'newer';
      limit?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    }>
  | Readonly<{
      mode: 'readAfter';
      cursor: string;
      limit?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    }>;

export type HostExternalTranscriptReadResult =
  | Readonly<{
      mode: 'page';
      items: readonly HostExternalTranscriptItem[];
      nextCursor: string | null;
      tailCursor?: string | null;
      hasMore?: boolean;
      truncated?: boolean;
    }>
  | Readonly<{ mode: 'readAfter'; outcome: 'already_current' }>
  | Readonly<{
      mode: 'readAfter';
      outcome: 'advanced';
      items: readonly HostExternalTranscriptItem[];
      nextCursor: string;
      boundary: string;
      hasMore: boolean;
      diagnostics?: readonly Readonly<{
        code: string;
        severity: 'benign' | 'required';
        count: number;
        positions: readonly number[];
      }>[];
    }>
  | Readonly<{
      mode: 'readAfter';
      outcome:
        | 'gap_or_cursor_expired'
        | 'source_replaced'
        | 'source_unavailable'
        | 'read_failed';
    }>;

export interface PluginExternalSessionsDomainAuthorService {
  capabilities(): {
    list: PluginOperationAvailability;
    attach: PluginOperationAvailability;
    takeover: PluginOperationAvailability;
    transcript: PluginOperationAvailability;
    follow: PluginOperationAvailability;
  };
  list(query?: {
    agentId?: ExternalSessionAgentId;
    sourceId?: ExternalSessionSourceId;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  }, options?: { signal?: AbortSignal }): Promise<{
    items: readonly HostExternalSessionCandidate[];
    nextCursor?: string | null;
    diagnostics?: readonly PluginDiagnosticData[];
  }>;
  attach(
    ref: HostExternalSessionRef,
    options?: { signal?: AbortSignal },
  ): Promise<{ sessionId: string }>;
  readTranscript(
    ref: HostExternalSessionRef,
    query?: HostExternalTranscriptReadQuery,
  ): Promise<HostExternalTranscriptReadResult>;
  followTranscript(
    ref: HostExternalSessionRef,
    options: { cursor?: string; signal?: AbortSignal },
    listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void>,
  ): Promise<HostExternalTranscriptFollowResult>;
}

/** Current-global author projection, derived from the public SDK owner. */
export type HostExternalSessionsAuthorService = SessionsService['external'];
export function createExternalSessionsUnavailableCapabilities(
  code: string,
): Awaited<ReturnType<HostExternalSessionsAuthorService['capabilities']>> {
  const unavailable = Object.freeze({
    status: 'unavailable' as const,
    code,
  });
  return Object.freeze({
    list: unavailable,
    attach: unavailable,
    takeover: unavailable,
    transcript: unavailable,
    follow: unavailable,
  });
}
export type HostExternalSessionsAuthorTranscriptFollowEvent = Parameters<
  Parameters<HostExternalSessionsAuthorService['followTranscript']>[2]
>[0];

/** Exact-generation, source-bearing Runtime composition authority. */
export interface ExternalSessionsCompositionPort {
  resolveFollowTarget(input: {
    agentId: ExternalSessionAgentId;
    remoteSessionId: ExternalSessionRef['remoteSessionId'];
    /**
     * Exact source this Session is already bound to, read by the host from the
     * Session's own link authority. When present the follow target resolves
     * through that source alone instead of scanning the Agent's configured
     * aggregate, so two configured sources exposing the same remote id cannot
     * make an already-bound Session ambiguous or silently rebind it to a source
     * it was never linked through. Callers outside the host's link authority
     * must not supply it.
     */
    boundSource?: ExternalSessionsSource;
    /** Private terminal admission ceiling; never projected through the public author service. */
    admissionDeadlineAtMs?: number;
    signal?: AbortSignal;
  }): Promise<HostExternalSessionFollowTargetResolution>;
  followTranscript(
    target: HostExternalSessionFollowTarget,
    options: {
      cursor?: string;
      /** Private terminal bootstrap fact; never projected through the public author service. */
      initialReplay?: boolean;
      /** One absolute deadline shared by the complete replay-to-live admission sequence. */
      admissionDeadlineAtMs?: number;
      signal?: AbortSignal;
    },
    listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void>,
  ): Promise<HostExternalTranscriptFollowResult>;
}

export type PluginExternalSessionsDomainComposition = Readonly<{
  authorService: PluginExternalSessionsDomainAuthorService;
  compositionPort: ExternalSessionsCompositionPort;
}>;
