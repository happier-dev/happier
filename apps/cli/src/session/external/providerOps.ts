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
  TranscriptSourceReadAfter,
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
    diagnostics?: readonly Readonly<{
      code: string;
      count: number;
      positions: readonly number[];
    }>[];
  }>
  | Readonly<{ outcome: 'gap_or_cursor_expired' }>
  | Readonly<{ outcome: 'source_replaced' }>
  | Readonly<{ outcome: 'source_unavailable' }>
  | Readonly<{ outcome: 'read_failed' }>;

/**
 * Compatibility adapter for host transcript-source utilities that still use
 * the pre-E9 page carrier. The explicit outcome remains authoritative.
 */
export function toLegacyTranscriptSourceReadAfter(
  result: ExternalSessionTranscriptReadAfter,
  currentCursor: string,
): TranscriptSourceReadAfter<ExternalSessionTranscriptRawMessageV1> {
  if (result.outcome === 'advanced') {
    return {
      items: [...result.items],
      nextCursor: result.nextCursor,
      truncated: false,
    };
  }
  if (result.outcome === 'already_current') {
    return { items: [], nextCursor: currentCursor, truncated: false };
  }
  return { items: [], nextCursor: null, truncated: true };
}

export type ExternalSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type ExternalSessionSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
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
    allowProviderFallback?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionTranscriptPage>;
  readAfterTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
    signal?: AbortSignal;
  }>) => Promise<ExternalSessionTranscriptReadAfter>;
  resolveTranscriptMediaReadRoots?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
  }>) => Promise<readonly string[]>;
  canonicalizeLinkedSession?: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
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
