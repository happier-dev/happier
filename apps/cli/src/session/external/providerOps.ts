import type {
  BackendSurfaceAvailabilityV1,
  ExternalSessionCandidateV1,
  ExternalSessionsSource,
  ExternalSessionTranscriptRawMessageV1,
  RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type {
  ExternalSessionAvailabilityRequestV1,
  ExternalSessionRuntimeContextV1,
  SessionStateUpdateV1,
  TranscriptSourceFollowLease,
  TranscriptSourcePage,
  TranscriptSourceReadAfter,
} from '@happier-dev/agents';

import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { createPollingExternalSessionFollowLease } from '@/api/session/external/backgroundFollow/createPollingExternalSessionFollowLease';

export type ExternalSessionCandidatesPage = Readonly<{
  candidates: readonly ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>;

export type ExternalSessionActivitySample = Readonly<{
  lastActivityAtMs: number | null;
  isRunning: boolean;
}>;

export type ExternalSessionTranscriptPage = TranscriptSourcePage<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionTranscriptReadAfter = TranscriptSourceReadAfter<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionFollowLeaseReason = 'attached_view' | 'background_follow';

export type ExternalSessionFollowLease = TranscriptSourceFollowLease<ExternalSessionTranscriptRawMessageV1>;

export type ExternalSessionFollowTranscriptPathResolution = Readonly<{
  path: string;
  sourceId?: string;
}>;

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
  evaluateAvailability?: (params: ExternalSessionAvailabilityRequestV1) => Promise<BackendSurfaceAvailabilityV1> | BackendSurfaceAvailabilityV1;
  validateSource: (params: Readonly<{
    source: ExternalSessionsSource;
    runtime?: ExternalSessionRuntimeContextV1;
    env?: NodeJS.ProcessEnv;
  }>) => Promise<ExternalSessionSourceValidationResult> | ExternalSessionSourceValidationResult;
  listCandidates: (params: Readonly<{
    source: ExternalSessionsSource;
    cursor?: string;
    limit: number;
    searchTerm?: string;
    searchMode?: 'fast' | 'full';
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionCandidatesPage>;
  getActivity: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionActivitySample>;
  pageTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionTranscriptPage>;
  readAfterTranscript: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    cursor: string;
    maxBytes: number;
    maxItems: number;
    allowProviderFallback?: boolean;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionTranscriptReadAfter>;
  resolveTranscriptMediaReadRoots?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<readonly string[]>;
  resolveFollowTranscriptPath?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    reason: ExternalSessionFollowLeaseReason;
    linkedSessionId?: string;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionFollowTranscriptPathResolution | null>;
  acquireFollowLease?: (params: Readonly<{
    source: ExternalSessionsSource;
    remoteSessionId: string;
    reason: ExternalSessionFollowLeaseReason;
    linkedSessionId?: string;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionFollowLease | null>;
  canonicalizeLinkedSession?: (params: Readonly<{
    metadata: Record<string, unknown>;
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
  }>>;
  resolveLinkIdentity?: (params: Readonly<{
    remoteSessionId: string;
    source: ExternalSessionsSource;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<ExternalSessionLinkIdentity>;
  resolveTakeoverSpawnOptions: (params: Readonly<{
    linked: LoadedLinkedExternalSession;
    sessionId: string;
    runtime?: ExternalSessionRuntimeContextV1;
  }>) => Promise<SpawnSessionOptions | null>;
}>;

export type ExternalSessionExecutionSurface = Readonly<Partial<ExternalSessionProviderOps>>;

type ExternalSessionTranscriptPageLoader<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes: number;
  maxItems: number;
  allowProviderFallback?: boolean;
}>) => Promise<TranscriptSourcePage<TItem>>;

type ExternalSessionTranscriptReadAfterLoader<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
  allowProviderFallback?: boolean;
}>) => Promise<TranscriptSourceReadAfter<TItem>>;

type ExternalSessionTranscriptFollowLeaseAcquirer<TItem> = (params: Readonly<{
  source: ExternalSessionsSource;
  remoteSessionId: string;
  reason: ExternalSessionFollowLeaseReason;
  linkedSessionId?: string;
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
