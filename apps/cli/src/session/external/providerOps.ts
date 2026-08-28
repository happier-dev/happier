import type {
  ExternalSessionCandidateV1,
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
  PluginAgentExternalLinkedTakeoverWriterSafetyV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  SessionStateUpdateV1,
  TranscriptSourcePage,
} from '@happier-dev/agents';

export type ExternalSessionCandidatesPage = Readonly<{
  candidates: readonly ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
  preparation?: Readonly<{
    kind: 'building_candidate_index';
    scanned: number;
    total?: number;
  }>;
}>;

export type ExternalSessionTranscriptPage = TranscriptSourcePage<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionTranscriptReadAfter =
  | Readonly<{ outcome: 'already_current' }>
  | Readonly<{
    outcome: 'advanced';
    items: readonly ExternalSessionTranscriptRawMessageV1[];
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
  | Readonly<{ outcome: 'gap_or_cursor_expired' }>
  | Readonly<{ outcome: 'source_replaced' }>
  | Readonly<{ outcome: 'source_unavailable' }>
  | Readonly<{ outcome: 'read_failed' }>;

export type ExternalSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  /** Source-owned transient media evidence; never persisted in link metadata. */
  transcriptMediaReadRoots?: readonly string[];
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type ExternalSessionSourceValidationResult =
  | Readonly<{
    ok: true;
    source: ExternalSessionsSource;
    /** Source-owned transient media evidence; absent evidence grants no roots. */
    transcriptMediaReadRoots?: readonly string[];
  }>
  | Readonly<{ ok: false; error: string }>;

export type ExternalSessionProviderOps = Readonly<{
  /**
   * Static Agent-leaf evidence for continuing single-writer safety after an
   * external-linked takeover. Absence always degrades to unsupported.
   */
  externalLinkedTakeoverWriterSafety?: PluginAgentExternalLinkedTakeoverWriterSafetyV1;
  validateSource: (params: Readonly<{
    source: ExternalSessionsSource;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionSourceValidationResult> | ExternalSessionSourceValidationResult;
  listCandidates: (params: Readonly<{
    source: ExternalSessionsSource;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    maxBytes?: number;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionCandidatesPage>;
  pageTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    /**
     * Optional caller-owned absolute ceiling for a larger admission that spans
     * several provider calls. The generation wrapper applies the earlier of
     * this value and its ordinary per-call deadline.
     */
    deadlineAtMs?: number;
    allowProviderFallback?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionTranscriptPage>;
  readAfterTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
    deadlineAtMs?: number;
    allowProviderFallback?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionTranscriptReadAfter>;
  canonicalizeLinkedSession?: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
    transcriptMediaReadRoots?: readonly string[];
  }>>;
  resolveLinkIdentity?: (params: Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionLinkIdentity>;
}>;

export class ExternalSessionProviderFailureError extends Error {
  readonly code: string;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(params: Readonly<{
    code: string;
    message: string;
    operation: string;
    retryable?: boolean;
  }>) {
    super(params.message);
    this.name = 'ExternalSessionProviderFailureError';
    this.code = params.code;
    this.operation = params.operation;
    this.retryable = params.retryable === true;
  }
}

export function isExternalSessionProviderFailureError(error: unknown): error is ExternalSessionProviderFailureError {
  return error instanceof ExternalSessionProviderFailureError;
}

export type ExternalSessionExecutionSurface = Readonly<Partial<ExternalSessionProviderOps>>;

/** Provider callbacks required by the canonical transcript-follow corridor. */
export type ExternalSessionFollowProviderOps = Required<Pick<
  ExternalSessionProviderOps,
  | 'validateSource'
  | 'resolveLinkIdentity'
  | 'pageTranscript'
  | 'readAfterTranscript'
>>;
