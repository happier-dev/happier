import type {
  Disposable,
  JsonValue,
  PluginDiagnosticData,
} from '@happier-dev/plugin-sdk';
import type { ExternalSessionsSource } from '@happier-dev/protocol';
import type { PluginOperationAvailability } from '@happier-dev/plugin-sdk/runtime';

export type HostExternalSessionRef = Readonly<{
  agentId: string;
  remoteSessionId: string;
  sourceId: string;
}>;

export type HostExternalSessionCandidate = Readonly<{
  ref: HostExternalSessionRef;
  title?: string;
  updatedAtMs?: number;
  capabilities: readonly ('attach' | 'takeover' | 'transcript' | 'follow')[];
}>;

export type HostExternalTranscriptItem = Readonly<{
  id: string;
  timestampMs?: number;
  kind: 'user' | 'agent' | 'system' | 'event';
  data: JsonValue;
}>;

export type HostExternalTranscriptFollowEvent =
  | Readonly<{
      kind: 'data';
      items: readonly HostExternalTranscriptItem[];
      fromCursor: string | null;
      nextCursor: string;
    }>
  | Readonly<{
      kind: 'resyncRequired';
      reason: 'cursorDiscontinuity' | 'providerTruncated' | 'bufferOverflow';
      cursor: string | null;
    }>
  | Readonly<{
      kind: 'terminated';
      reason: 'disposed' | 'aborted' | 'retired' | 'providerFailure' | 'resyncRequired';
      cursor: string | null;
      code?: string;
    }>;

export type HostExternalTranscriptFollowResult =
  | Readonly<{
      status: 'following';
      startingCursor: string | null;
      subscription: Disposable;
    }>
  | Readonly<{
      status: 'unavailable';
      code: string;
    }>;

export type HostExternalSessionFollowTarget = Readonly<{
  ref: HostExternalSessionRef;
  source: ExternalSessionsSource;
}>;

export type HostExternalSessionFollowTargetResolution =
  | Readonly<HostExternalSessionFollowTarget & {
      status: 'resolved';
    }>
  | Readonly<{
      status: 'unavailable';
      code: string;
    }>;

export type HostExternalTranscriptReadQuery =
  | Readonly<{
      mode?: 'page';
      cursor?: string;
      direction?: 'older' | 'newer';
      limit?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    }>
  | Readonly<{
      mode: 'readAfter';
      cursor: string;
      limit?: number;
      maxBytes?: number;
      signal?: AbortSignal;
    }>;

export interface HostExternalSessionsService {
  capabilities(): {
    list: PluginOperationAvailability;
    attach: PluginOperationAvailability;
    takeover: PluginOperationAvailability;
    transcript: PluginOperationAvailability;
    follow: PluginOperationAvailability;
  };
  list(query?: {
    agentId?: string;
    sourceId?: string;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  }): Promise<{
    items: readonly HostExternalSessionCandidate[];
    nextCursor?: string;
    diagnostics?: readonly PluginDiagnosticData[];
  }>;
  attach(
    ref: HostExternalSessionRef,
    options?: { signal?: AbortSignal },
  ): Promise<{ sessionId: string }>;
  takeover(
    ref: HostExternalSessionRef,
    options?: { signal?: AbortSignal },
  ): Promise<{ sessionId: string; status: 'attached' | 'takenOver' }>;
  resolveFollowTarget(input: {
    agentId: string;
    remoteSessionId: string;
    signal?: AbortSignal;
  }): Promise<HostExternalSessionFollowTargetResolution>;
  readTranscript(
    ref: HostExternalSessionRef,
    query?: HostExternalTranscriptReadQuery,
  ): Promise<{ items: readonly HostExternalTranscriptItem[]; nextCursor?: string }>;
  followTranscript(
    target: HostExternalSessionFollowTarget,
    options: { cursor?: string; signal?: AbortSignal },
    listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void>,
  ): Promise<HostExternalTranscriptFollowResult>;
}
