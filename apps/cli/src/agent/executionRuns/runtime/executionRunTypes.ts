import type { ExecutionRunDisplay, ExecutionRunIntent, ExecutionRunResumeHandle } from '@happier-dev/protocol';

import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

export type ExecutionRunManagerStartParams = Readonly<{
  sessionId: string;
  intent: ExecutionRunIntent;
  backendId: string;
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
  resumeHandle?: ExecutionRunResumeHandle | null;
  parentRunId?: string;
  parentCallId?: string;
  // voice_agent-specific configuration (used when intent='voice_agent').
  chatModelId?: string;
  commitModelId?: string;
  commitIsolation?: boolean;
  idleTtlSeconds?: number;
  initialContext?: string;
  verbosity?: 'short' | 'balanced';
  bootstrapMode?: 'ready_handshake' | 'none';
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
  backendId: string;
  instructions: string;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  retentionPolicy: ExecutionRunManagerStartParams['retentionPolicy'];
  runClass: ExecutionRunManagerStartParams['runClass'];
  ioMode: ExecutionRunManagerStartParams['ioMode'];
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAtMs: number;
  finishedAtMs?: number;
  error?: { code: string; message?: string };
  summary?: string;
  structuredMeta?: ExecutionRunStructuredMeta;
  latestToolResult?: unknown;
  resumeHandle?: ExecutionRunResumeHandle | null;
  voiceAgentConfig?: Readonly<{
    chatModelId: string;
    commitModelId: string;
    commitIsolation: boolean;
    permissionPolicy: 'no_tools' | 'read_only';
    idleTtlSeconds: number;
    initialContext: string;
    verbosity: 'short' | 'balanced';
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

