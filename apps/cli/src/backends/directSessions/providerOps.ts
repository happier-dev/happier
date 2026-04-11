import type {
  AgentRuntimeDescriptorV1,
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

export type DirectSessionFollowLeaseReason = 'attached_view' | 'background_follow';

export type DirectSessionFollowLease = Readonly<{
  release: () => Promise<void>;
  subscribeToTranscriptUpdates?: (
    listener: (update: Readonly<{
      items: readonly DirectTranscriptRawMessageV1[];
      nextCursor: string | null;
      truncated: boolean;
    }>) => void | Promise<void>,
  ) => () => void;
  getTailCursor?: () => string | null;
}>;

export type DirectSessionLinkIdentity = Readonly<{
  remoteSessionId: string;
  source: DirectSessionsSource;
  runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
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
    runtimeDescriptor?: AgentRuntimeDescriptorV1 | null;
    metadata?: Record<string, unknown>;
  }>) => Promise<DirectSessionLinkIdentity>;
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
