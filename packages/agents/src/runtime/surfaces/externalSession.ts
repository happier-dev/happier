import type { MaybePromise } from '../engine/contracts.js';
import type {
  BackendSurfaceAvailabilityV1,
  ExternalSessionCandidateV1,
  ExternalSessionsAgentId,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsSearchMode,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { TranscriptSourceFollowLease } from '../facets/transcriptSource.js';
import type {
  BackendSurfaceDiagnosticV1,
  BackendSessionLaunchHintsV1,
  BackendSurfaceResultV1,
  SessionStateUpdateV1,
} from './primitives.js';

export type ExternalSessionFailureCodeV1 =
  | 'source_invalid'
  | 'source_unreachable'
  | 'candidate_not_found'
  | 'follow_not_supported'
  | 'takeover_not_available'
  | 'agent_unavailable';

export type ExternalSessionAvailabilityOperationV1 =
  | 'resolveSource'
  | 'listCandidates'
  | 'getActivity'
  | 'pageTranscript'
  | 'readAfterTranscript'
  | 'resolveFollowTranscriptPath'
  | 'acquireFollowLease'
  | 'resolveLinkIdentity'
  | 'resolveLinkedIdentity'
  | 'resolveTakeoverLaunch';

export type ExternalSessionAvailabilityRequestV1 = Readonly<{
  operation: ExternalSessionAvailabilityOperationV1;
  source?: ExternalSessionsSource;
  providerSessionId?: string;
  linkedSessionId?: string;
  directory?: string;
}>;

export type ExternalSessionFileFollowStartAtV1 = 'beginning' | 'end';

export type ExternalSessionFileFollowStrategyV1 = 'poll';

export type ExternalSessionFileFollowLineV1 = Readonly<{
  line: string;
  sourcePath: string;
  sequence: number;
}>;

export type ExternalSessionFileFollowResetReasonV1 = 'missing' | 'replaced' | 'truncated';

export type ExternalSessionFileFollowPolicyInputV1 = Readonly<{
  pollIntervalMs?: number;
  missingFileRetryIntervalMs?: number;
  maxDrainRowsPerTick?: number;
  maxDrainBytesPerTick?: number;
}>;

export type ExternalSessionFileFollowInputV1 = Readonly<{
  path: string;
  startAt: ExternalSessionFileFollowStartAtV1;
  strategy?: ExternalSessionFileFollowStrategyV1;
  policy?: ExternalSessionFileFollowPolicyInputV1;
  signal?: AbortSignal;
  onLine(line: ExternalSessionFileFollowLineV1): void | Promise<void>;
  onReset?(event: Readonly<{ reason: ExternalSessionFileFollowResetReasonV1 }>): void | Promise<void>;
  onError?(error: unknown): void | Promise<void>;
}>;

export type ExternalSessionFileFollowHandleV1 = Readonly<{
  id: string;
  drainNow(options?: Readonly<{ timeoutMs?: number }>): Promise<void>;
  close(options?: Readonly<{ finalDrain?: boolean; drainTimeoutMs?: number }>): Promise<void>;
}>;

export type ExternalSessionFileFollowRuntimeServiceV1 = Readonly<{
  follow(input: ExternalSessionFileFollowInputV1): Promise<ExternalSessionFileFollowHandleV1>;
}>;

export type ExternalSessionProviderStoreKeyV1 = Readonly<{
  agentId: ExternalSessionsAgentId;
  source: ExternalSessionsSource;
  providerSessionId: string;
}>;

export type ExternalSessionTranscriptStorePageRequestV1 = ExternalSessionProviderStoreKeyV1 & Readonly<{
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>;

export type ExternalSessionTranscriptStoreReadAfterRequestV1 = ExternalSessionProviderStoreKeyV1 & Readonly<{
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>;

export type ExternalSessionTranscriptStoreFollowRequestV1 = ExternalSessionProviderStoreKeyV1 & Readonly<{
  reason: 'attached_view' | 'background_follow';
  linkedSessionId?: string;
}>;

export type ExternalSessionTranscriptStoreRuntimeServiceV1 = Readonly<{
  getActivity(input: ExternalSessionProviderStoreKeyV1): Promise<ExternalSessionActivityResultV1>;
  page(input: ExternalSessionTranscriptStorePageRequestV1): Promise<ExternalSessionTranscriptPageV1>;
  readAfter(input: ExternalSessionTranscriptStoreReadAfterRequestV1): Promise<ExternalSessionTranscriptPageV1>;
  acquireFollowLease(input: ExternalSessionTranscriptStoreFollowRequestV1): Promise<ExternalSessionFollowLeaseV1>;
  resolveFollowTranscriptPath(input: ExternalSessionTranscriptStoreFollowRequestV1): Promise<ExternalSessionFollowTranscriptPathResolutionV1>;
  getWorkingDirectory(input: ExternalSessionProviderStoreKeyV1): Promise<string | null>;
  getProviderHome(input: ExternalSessionProviderStoreKeyV1): Promise<string | null>;
}>;

export type ExternalSessionCandidateHostListRequestV1 = Readonly<{
  agentId: ExternalSessionsAgentId;
  source: ExternalSessionsSource;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: ExternalSessionsSearchMode;
}>;

export type ExternalSessionCandidateHostRuntimeServiceV1 = Readonly<{
  listViaChildHost(input: ExternalSessionCandidateHostListRequestV1): Promise<ExternalSessionCandidatePageV1>;
}>;

export type ExternalSessionRuntimeContextV1 = Readonly<{
  signal: AbortSignal;
  session?: Readonly<{
    sessionId?: string;
    directory?: string;
  }>;
  directories?: Readonly<{
    activeServerDir?: string;
    logsDir?: string;
  }>;
  transcripts?: Readonly<{
    fileFollow?: ExternalSessionFileFollowRuntimeServiceV1;
  }>;
  external?: Readonly<{
    transcripts?: ExternalSessionTranscriptStoreRuntimeServiceV1;
    candidates?: ExternalSessionCandidateHostRuntimeServiceV1;
  }>;
  diagnostics: Readonly<{
    issue(diagnostic: BackendSurfaceDiagnosticV1): void | Promise<void>;
  }>;
}>;

export type ExternalSessionResolveSourceRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  /**
   * Host-supplied environment for deterministic source validation/canonicalization.
   * This is intentionally scoped to source resolution; runtime operations receive
   * host services through `runtime` instead of ambient process state.
   */
  env?: NodeJS.ProcessEnv;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionResolveSourceResultV1 = Readonly<{
  source: ExternalSessionsSource;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type ExternalSessionListCandidatesRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  cursor?: string;
  limit: number;
  searchTerm?: string;
  searchMode?: ExternalSessionsSearchMode;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionCandidatePageV1 = Readonly<{
  candidates: readonly ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>;

export type ExternalSessionActivityRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionActivityResultV1 = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

export type ExternalSessionTranscriptPageRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionReadAfterRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionTranscriptPageV1 = Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>;

export type ExternalSessionFollowLeaseRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  reason: 'attached_view' | 'background_follow';
  linkedSessionId?: string;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionFollowLeaseV1 = TranscriptSourceFollowLease<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionResolveFollowTranscriptPathRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  reason: 'attached_view' | 'background_follow';
  linkedSessionId?: string;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionFollowTranscriptPathResolutionV1 = Readonly<{
  path: string;
  sourceId?: string;
}>;

export type ExternalSessionResolveLinkIdentityRequestV1 = Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Readonly<Record<string, unknown>>;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionResolveLinkedIdentityRequestV1 = Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionResolvedIdentityV1 = Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;

export type ExternalSessionTakeoverLaunchRequestV1 = Readonly<{
  linkedSessionId: string;
  providerSessionId: string;
  source: ExternalSessionsSource;
  metadata: Readonly<Record<string, unknown>>;
  runtime?: ExternalSessionRuntimeContextV1;
}>;

export type ExternalSessionTakeoverLaunchResultV1 = Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  launch: BackendSessionLaunchHintsV1;
}>;

export type ExternalSessionSurfaceV1 = Readonly<{
  evaluateAvailability?: (request: ExternalSessionAvailabilityRequestV1) => MaybePromise<BackendSurfaceAvailabilityV1>;
  resolveSource: (
    request: ExternalSessionResolveSourceRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionResolveSourceResultV1, ExternalSessionFailureCodeV1>>;
  listCandidates: (
    request: ExternalSessionListCandidatesRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionCandidatePageV1, ExternalSessionFailureCodeV1>>;
  getActivity?: (
    request: ExternalSessionActivityRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionActivityResultV1, ExternalSessionFailureCodeV1>>;
  pageTranscript: (
    request: ExternalSessionTranscriptPageRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionTranscriptPageV1, ExternalSessionFailureCodeV1>>;
  readAfterTranscript?: (
    request: ExternalSessionReadAfterRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionTranscriptPageV1, ExternalSessionFailureCodeV1>>;
  resolveFollowTranscriptPath?: (
    request: ExternalSessionResolveFollowTranscriptPathRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionFollowTranscriptPathResolutionV1, ExternalSessionFailureCodeV1>>;
  acquireFollowLease?: (
    request: ExternalSessionFollowLeaseRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionFollowLeaseV1, ExternalSessionFailureCodeV1>>;
  resolveLinkIdentity?: (
    request: ExternalSessionResolveLinkIdentityRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionResolvedIdentityV1, ExternalSessionFailureCodeV1>>;
  resolveLinkedIdentity?: (
    request: ExternalSessionResolveLinkedIdentityRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionResolvedIdentityV1, ExternalSessionFailureCodeV1>>;
  resolveTakeoverLaunch?: (
    request: ExternalSessionTakeoverLaunchRequestV1
  ) => MaybePromise<BackendSurfaceResultV1<ExternalSessionTakeoverLaunchResultV1, ExternalSessionFailureCodeV1>>;
}>;
