import type {
  ExternalSessionActivityV1,
  ExternalSessionCandidateV1,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionsSearchMode,
  ExternalSessionsSource,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  SessionStateUpdateV1,
} from './primitives.js';

export type ExternalSessionFailureCodeV1 =
  | 'source_invalid'
  | 'source_unreachable'
  | 'candidate_not_found'
  | 'follow_not_supported'
  | 'takeover_not_available'
  | 'agent_unavailable';

export type ExternalSessionResolveSourceRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  /**
   * Host-supplied environment for deterministic source validation/canonicalization.
   * This is intentionally scoped to source resolution rather than ambient process state.
   */
  env?: Readonly<Record<string, string | undefined>>;
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
}>;

export type ExternalSessionCandidatePageV1 = Readonly<{
  candidates: readonly ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>;

export function deriveExternalSessionActivity(params: Readonly<{
  updatedAtMs: number | null | undefined;
  env?: Readonly<Record<string, string | undefined>>;
  nowMs?: number;
}>): ExternalSessionActivityV1 {
  const updatedAtMs = typeof params.updatedAtMs === 'number' && Number.isFinite(params.updatedAtMs)
    ? Math.trunc(params.updatedAtMs)
    : null;
  if (updatedAtMs === null || updatedAtMs < 0) return 'unknown';

  const nowMs = params.nowMs ?? Date.now();
  const ageMs = nowMs - updatedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'unknown';

  const env = params.env ?? process.env;
  const rawWindowMs = Number.parseInt(String(env.HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS ?? ''), 10);
  const configuredWindowMs = Number.isFinite(rawWindowMs) && rawWindowMs > 0
    ? Math.trunc(rawWindowMs)
    : 15_000;
  const recentWindowMs = Math.max(1_000, Math.min(60 * 60 * 1_000, configuredWindowMs));
  return ageMs <= recentWindowMs ? 'active_recently' : 'idle';
}

export type ExternalSessionTranscriptPageRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>;

export type ExternalSessionReadAfterRequestV1 = Readonly<{
  source: ExternalSessionsSource;
  providerSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>;

export type ExternalSessionTranscriptPageV1 = Readonly<{
  items: readonly ExternalSessionTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
}>;

export type ExternalSessionResolveLinkIdentityRequestV1 = Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ExternalSessionResolveLinkedIdentityRequestV1 = Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  providerSessionId: string;
  source: ExternalSessionsSource;
}>;

export type ExternalSessionResolvedIdentityV1 = Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
  sessionStateUpdates?: readonly SessionStateUpdateV1[];
}>;
