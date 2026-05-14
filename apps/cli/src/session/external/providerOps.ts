import type {
  ExternalSessionCandidateV1,
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  TranscriptSourceFollowLease,
  TranscriptSourcePage,
  TranscriptSourceReadAfter,
} from '@happier-dev/agents';

import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createPollingExternalSessionFollowLease } from '@/api/session/external/backgroundFollow/createPollingExternalSessionFollowLease';

export type ExternalSessionCandidatesPage = Readonly<{
  candidates: ExternalSessionCandidateV1[];
  nextCursor: string | null;
}>;

export type ExternalSessionActivitySample = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

export type ExternalSessionTranscriptPage = TranscriptSourcePage<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionTranscriptReadAfter = TranscriptSourceReadAfter<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionFollowLeaseReason = 'attached_view' | 'background_follow';

export type ExternalSessionFollowLease = TranscriptSourceFollowLease<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
  vendorMetadata?: Record<string, unknown>;
  externalSessionMetadata?: Record<string, unknown>;
}>;

export type ExternalSessionSourceValidationResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

export type ExternalSessionProviderOps = Readonly<{
  validateSource: (params: Readonly<{
    source: ExternalSessionsSource;
    env: NodeJS.ProcessEnv;
  }>) => Promise<ExternalSessionSourceValidationResult> | ExternalSessionSourceValidationResult;
  listCandidates: (params: Readonly<{
    source: ExternalSessionsSource;
    cursor?: string;
    limit: number;
    searchTerm?: string;
  }>) => Promise<ExternalSessionCandidatesPage>;
  getActivity: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
  }>) => Promise<ExternalSessionActivitySample>;
  pageTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<ExternalSessionTranscriptPage>;
  readAfterTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => Promise<ExternalSessionTranscriptReadAfter>;
  resolveTranscriptMediaReadRoots?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
  }>) => Promise<readonly string[]>;
  acquireFollowLease?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    reason: ExternalSessionFollowLeaseReason;
  }>) => Promise<ExternalSessionFollowLease | null>;
  canonicalizeLinkedSession?: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>) => Promise<Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>>;
  resolveLinkIdentity?: (params: Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>) => Promise<ExternalSessionLinkIdentity>;
  resolveTakeoverSpawnOptions: (params: Readonly<{
    linked: LoadedLinkedExternalSession;
    sessionId: string;
  }>) => Promise<SpawnSessionOptions | null>;
}>;

type ExternalSessionTranscriptPageLoader<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
}>) => Promise<TranscriptSourcePage<TItem>>;

type ExternalSessionTranscriptReadAfterLoader<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>) => Promise<TranscriptSourceReadAfter<TItem>>;

type ExternalSessionTranscriptFollowLeaseAcquirer<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  reason: ExternalSessionFollowLeaseReason;
}>) => Promise<TranscriptSourceFollowLease<TItem> | null>;

export function createExternalSessionTranscriptProviderOps<TItem>(params: Readonly<{
  pageOlder: ExternalSessionTranscriptPageLoader<TItem>;
  readAfter: ExternalSessionTranscriptReadAfterLoader<TItem>;
  acquireFollowLease?: ExternalSessionTranscriptFollowLeaseAcquirer<TItem>;
}>): Readonly<{
  pageTranscript: ExternalSessionTranscriptPageLoader<TItem>;
  readAfterTranscript: ExternalSessionTranscriptReadAfterLoader<TItem>;
  acquireFollowLease?: ExternalSessionTranscriptFollowLeaseAcquirer<TItem>;
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
      return await createPollingExternalSessionFollowLease<TItem>({
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

export function mergeExternalSessionEnvironmentVariables(values: Array<Record<string, string> | null>): Record<string, string> | undefined {
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
