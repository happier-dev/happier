import type {
  DirectSessionCandidateV1,
  DirectSessionsSource,
  DirectTranscriptRawMessageV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  TranscriptSourceFollowLease,
  TranscriptSourcePage,
  TranscriptSourceReadAfter,
} from '@happier-dev/agents';

import type { LoadedLinkedDirectSession } from '@/api/directSessions/takeover/loadLinkedDirectSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createPollingDirectSessionFollowLease } from '@/api/directSessions/backgroundFollow/createPollingDirectSessionFollowLease';

export type DirectSessionCandidatesPage = Readonly<{
  candidates: DirectSessionCandidateV1[];
  nextCursor: string | null;
}>;

export type DirectSessionActivitySample = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

export type DirectSessionTranscriptPage = TranscriptSourcePage<DirectTranscriptRawMessageV1>;

export type DirectSessionTranscriptReadAfter = TranscriptSourceReadAfter<DirectTranscriptRawMessageV1>;

export type DirectSessionFollowLeaseReason = 'attached_view' | 'background_follow';

export type DirectSessionFollowLease = TranscriptSourceFollowLease<DirectTranscriptRawMessageV1>;

export type DirectSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  directSessionMetadata?: Record<string, unknown>;
}>;

export type DirectSessionSourceValidationResult =
  | Readonly<{ ok: true; source: DirectSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

export type DirectSessionProviderOps = Readonly<{
  validateSource: (params: Readonly<{
    source: DirectSessionsSource;
    env: NodeJS.ProcessEnv;
  }>) => Promise<DirectSessionSourceValidationResult> | DirectSessionSourceValidationResult;
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
  acquireFollowLease?: (params: Readonly<{
    source: DirectSessionsSource;
    remoteSessionId: string;
    reason: DirectSessionFollowLeaseReason;
  }>) => Promise<DirectSessionFollowLease | null>;
  canonicalizeLinkedSession?: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: DirectSessionsSource;
  }>) => Promise<Readonly<{
    remoteSessionId: string;
    source: DirectSessionsSource;
  }>>;
  resolveLinkIdentity?: (params: Readonly<{
    remoteSessionId: string;
    source: DirectSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>) => Promise<DirectSessionLinkIdentity>;
  resolveTakeoverSpawnOptions: (params: Readonly<{
    linked: LoadedLinkedDirectSession;
    sessionId: string;
  }>) => Promise<SpawnSessionOptions | null>;
}>;

type DirectSessionTranscriptPageLoader<TItem> = (params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>) => Promise<TranscriptSourcePage<TItem>>;

type DirectSessionTranscriptReadAfterLoader<TItem> = (params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>) => Promise<TranscriptSourceReadAfter<TItem>>;

type DirectSessionTranscriptFollowLeaseAcquirer<TItem> = (params: Readonly<{
  source: DirectSessionsSource;
  remoteSessionId: string;
  reason: DirectSessionFollowLeaseReason;
}>) => Promise<TranscriptSourceFollowLease<TItem> | null>;

export function createDirectSessionTranscriptProviderOps<TItem>(params: Readonly<{
  pageOlder: DirectSessionTranscriptPageLoader<TItem>;
  readAfter: DirectSessionTranscriptReadAfterLoader<TItem>;
  acquireFollowLease?: DirectSessionTranscriptFollowLeaseAcquirer<TItem>;
}>): Readonly<{
  pageTranscript: DirectSessionTranscriptPageLoader<TItem>;
  readAfterTranscript: DirectSessionTranscriptReadAfterLoader<TItem>;
  acquireFollowLease?: DirectSessionTranscriptFollowLeaseAcquirer<TItem>;
}> {
  return {
    pageTranscript: async (input) => {
      return await params.pageOlder(input);
    },
    readAfterTranscript: async (input) => {
      return await params.readAfter(input);
    },
    acquireFollowLease: async (input) => {
      if (params.acquireFollowLease) {
        return await params.acquireFollowLease(input);
      }
      return await createPollingDirectSessionFollowLease<TItem>({
        readAfterTranscript: ({ cursor, maxBytes, maxItems }) =>
          params.readAfter({
            source: input.source,
            remoteSessionId: input.remoteSessionId,
            cursor,
            maxBytes,
            maxItems,
          }),
      });
    },
  };
}

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
