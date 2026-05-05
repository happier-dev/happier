import { randomUUID } from 'node:crypto';

import type { SessionId } from '@/agent/core/AgentBackend';
import type { BoundedTextFileAppender } from '@/agent/runtime/subprocessArtifacts';
import { query } from '@/backends/claude/sdk/query';
import type { SDKMessage } from '@/backends/claude/sdk/types';
import { ClaudeTurnChangeTracker } from '../utils/ClaudeTurnChangeTracker';
import type { PendingClaudePermissionRequest, PendingClaudeTurn, VendorSessionIdResolver } from './types';

export type ClaudeSdkLifecycleState = {
  localSessionId: SessionId;
  acceptedSessionIds: Set<SessionId>;
  vendorSessionId: SessionId | null;
  resolveVendorSessionId: VendorSessionIdResolver;
  vendorSessionIdPromise: Promise<SessionId>;
  started: boolean;
  disposed: boolean;
  fatalError: Error | null;
};

export type ClaudeSdkRuntimeState = {
  stderrAppender: BoundedTextFileAppender | null;
  query: ReturnType<typeof query> | null;
  queryIter: AsyncIterableIterator<SDKMessage> | null;
  loopPromise: Promise<void> | null;
  sendChain: Promise<void>;
  pendingTurn: PendingClaudeTurn | null;
  pendingTurnCompletion: Promise<void> | null;
  ignoreNextNonSuccessResult: boolean;
  currentTurnOrdinal: number;
  settledTurnOrdinal: number;
  toolNameByCallId: Map<string, string>;
  suppressedExplicitDiffCallIds: Set<string>;
  turnChangeTracker: ClaudeTurnChangeTracker;
  pendingPermissionRequests: Map<string, PendingClaudePermissionRequest>;
};

export function createClaudeSdkLifecycleState(): ClaudeSdkLifecycleState {
  let resolveVendorSessionId: VendorSessionIdResolver = null;
  const localSessionId = `voice-agent-claude-${randomUUID()}` as SessionId;
  const vendorSessionIdPromise = new Promise<SessionId>((resolve) => {
    resolveVendorSessionId = resolve;
  });
  return {
    localSessionId,
    acceptedSessionIds: new Set<SessionId>([localSessionId]),
    vendorSessionId: null,
    resolveVendorSessionId,
    vendorSessionIdPromise,
    started: false,
    disposed: false,
    fatalError: null,
  };
}

export function createClaudeSdkRuntimeState(): ClaudeSdkRuntimeState {
  return {
    stderrAppender: null,
    query: null,
    queryIter: null,
    loopPromise: null,
    sendChain: Promise.resolve(),
    pendingTurn: null,
    pendingTurnCompletion: null,
    ignoreNextNonSuccessResult: false,
    currentTurnOrdinal: 0,
    settledTurnOrdinal: 0,
    toolNameByCallId: new Map<string, string>(),
    suppressedExplicitDiffCallIds: new Set<string>(),
    turnChangeTracker: new ClaudeTurnChangeTracker(),
    pendingPermissionRequests: new Map<string, PendingClaudePermissionRequest>(),
  };
}
