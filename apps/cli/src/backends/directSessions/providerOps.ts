import type {
  DirectSessionCandidateV1,
  DirectSessionsSource,
  DirectTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';

export type DirectSessionCandidatesPage = Readonly<{
  candidates: DirectSessionCandidateV1[];
  nextCursor: string | null;
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
}>;

export type DirectSessionTranscriptReadAfter = Readonly<{
  items: DirectTranscriptRawMessageV1[];
  nextCursor: string | null;
  truncated: boolean;
}>;

export type DirectSessionProviderOps = Readonly<{
  listCandidates: (params: Readonly<{
    source: DirectSessionsSource;
    cursor?: string;
    limit: number;
    searchTerm?: string;
  }>) => Promise<DirectSessionCandidatesPage>;
  getActivity: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
  }>) => Promise<DirectSessionActivitySample>;
  pageTranscript: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<DirectSessionTranscriptPage>;
  readAfterTranscript: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<DirectSessionTranscriptReadAfter>;
  resolveTakeoverSpawnOptions: (params: Readonly<{
    linked: LoadedLinkedDirectSession;
    sessionId: string;
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
