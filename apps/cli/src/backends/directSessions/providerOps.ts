import type {
  DirectSessionCandidateV1,
  DirectSessionsSource,
  DirectTranscriptRawMessageV1,
  DirectTranscriptTruncationReason,
} from '@happier-dev/protocol';

import type {
  DirectSessionFollowLease,
  DirectSessionFollowLeaseReason,
} from '@/api/directSessions/backgroundFollow/createManagedDirectSessionFollowLease';
import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

import type { ObservedProcess } from './processMatch';

export type DirectSessionCandidatesPage = Readonly<{
  candidates: DirectSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
  capabilities?: Readonly<{
    deleteCandidate: boolean;
  }>;
}>;

export type DirectSessionActivitySample = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

export type DirectSessionTranscriptPage = Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  tailCursor: string | null;
  hasMore: boolean;
  truncated: boolean;
  truncationReason?: DirectTranscriptTruncationReason;
}>;

export type DirectSessionTranscriptReadAfter = Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  truncated: boolean;
  truncationReason?: DirectTranscriptTruncationReason;
}>;

/**
 * A direct-sessions operation the resolved provider genuinely cannot perform for this source.
 * Callers map it to `provider_unavailable` so the surface degrades truthfully instead of reporting
 * an internal error or an empty-but-successful result.
 */
export class DirectSessionsProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectSessionsProviderUnavailableError';
  }
}

/**
 * Transcript, activity and takeover members are optional: a resume-only source (ACP `session/list`)
 * can enumerate candidates without owning the provider's transcript store or process lifecycle.
 */
export type DirectSessionProviderOps = Readonly<{
  listCandidates: (params: Readonly<{
    source: DirectSessionsSource;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
  }>) => Promise<DirectSessionCandidatesPage>;
  deleteCandidate?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
  }>) => Promise<void>;
  getActivity?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
  }>) => Promise<DirectSessionActivitySample>;
  /** The directory the provider session runs in, read from the provider's own session store. */
  getWorkingDirectory?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
  }>) => Promise<string | null>;
  /**
   * Whether a process from a snapshot is this provider's agent. Evidence of a live provider
   * process only; it does not identify which of the provider's sessions the process serves.
   */
  matchesProviderProcess?: (process: ObservedProcess) => boolean;
  /**
   * The source to sweep for background observation, present only when listing candidates from it
   * with `searchMode: 'fast'` (how passive sweeps list) is read-only and starts nothing — no
   * provider server or agent process. Absent means the provider is not passively observed.
   */
  passiveObservationSource?: () => DirectSessionsSource;
  pageTranscript?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<DirectSessionTranscriptPage>;
  readAfterTranscript?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<DirectSessionTranscriptReadAfter>;
  acquireFollowLease?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    reason: DirectSessionFollowLeaseReason;
  }>) => Promise<DirectSessionFollowLease | null>;
  resolveTakeoverSpawnOptions?: (params: Readonly<{
    linked: LoadedLinkedDirectSession;
    sessionId: string;
    transcriptStorage: 'direct' | 'persisted';
  }>) => Promise<SpawnSessionOptions | null>;
}>;

export function mergeDirectSessionEnvironmentVariables(values: Array<Record<string, string> | null>): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const value of values) {
    if (!value) continue;
    for (const [key, raw] of Object.entries(value)) {
      const normalized = String(raw ?? '').trim();
      if (!normalized) continue;
      merged[key] = normalized;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
