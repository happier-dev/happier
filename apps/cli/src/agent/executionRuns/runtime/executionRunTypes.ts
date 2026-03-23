import type { BackendTargetRefV1, ExecutionRunDisplay, ExecutionRunIntent, ExecutionRunResumeHandle } from '@happier-dev/protocol';

import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

export type ExecutionRunManagerStartParams = Readonly<{
  sessionId: string;
  intent: ExecutionRunIntent;
  backendTarget: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  instructions?: string;
  /**
   * Intent-scoped configuration. The execution-run substrate treats this as opaque,
   * but backends/engines may interpret it (e.g. native review CLIs like CodeRabbit).
   */
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  retentionPolicy: 'ephemeral' | 'resumable';
  runClass: 'bounded' | 'long_lived';
  ioMode: 'request_response' | 'streaming';
  profileId?: string | null;
  // Internal runtime override for bounded-run timeouts. Not part of the public RPC contract.
  boundedTimeoutMs?: number;
  resumeHandle?: ExecutionRunResumeHandle | null;
  parentRunId?: string;
  parentCallId?: string;
  // voice_agent-specific configuration (used when intent='voice_agent').
  chatModelId?: string;
  commitModelId?: string;
  commitIsolation?: boolean;
  idleTtlSeconds?: number;
  initialContext?: string;
  initialContextMode?: 'bootstrap' | 'first_turn';
  verbosity?: 'short' | 'balanced';
  bootstrapMode?: 'ready_handshake' | 'none';
  bootstrapTimeoutMs?: number;
  disabledActionIds?: readonly string[];
  transcript?: Readonly<{ persistenceMode?: 'ephemeral' | 'persistent'; epoch?: number }>;
}>;

export type ExecutionRunStartResult = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
}>;

export type ExecutionRunState = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  sessionId: string;
  depth: number;
  intent: ExecutionRunManagerStartParams['intent'];
  backendTarget: BackendTargetRefV1;
  backendId: string;
  instructions: string;
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  retentionPolicy: ExecutionRunManagerStartParams['retentionPolicy'];
  runClass: ExecutionRunManagerStartParams['runClass'];
  ioMode: ExecutionRunManagerStartParams['ioMode'];
  /**
   * Cumulative backend turn count for long-lived runs.
   * Persisted in run state so resuming cannot reset enforcement (for example maxTurns).
   */
  turnCount?: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAtMs: number;
  finishedAtMs?: number;
  error?: { code: string; message?: string };
  summary?: string;
  structuredMeta?: ExecutionRunStructuredMeta;
  latestToolResult?: unknown;
  resumeHandle?: ExecutionRunResumeHandle | null;
  voiceAgentConfig?: Readonly<{
    profileId?: string | null;
    chatModelId: string;
    commitModelId: string;
    commitIsolation: boolean;
    permissionPolicy: 'no_tools' | 'read_only';
    idleTtlSeconds: number;
    initialContext: string;
    initialContextMode: 'bootstrap' | 'first_turn';
    verbosity: 'short' | 'balanced';
    bootstrapTimeoutMs?: number;
    disabledActionIds: readonly string[];
    transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  }>;
}>;

export type ExecutionRunActionParams = Readonly<{
  actionId: string;
  input?: unknown;
}>;

export type ExecutionRunActionResult = Readonly<{
  ok: boolean;
  errorCode?: string;
  error?: string;
  updatedToolResult?: unknown;
  result?: unknown;
}>;
