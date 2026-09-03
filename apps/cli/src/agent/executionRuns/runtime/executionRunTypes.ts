import type { AcpConfigOptionOverridesV1, BackendTargetRefV1, ConnectedServiceBindingsV1, ExecutionRunDisplay, ExecutionRunIntent, ExecutionRunLaunchOrigin, ExecutionRunResumeHandle } from '@happier-dev/protocol';

import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunConnectedServiceRegistrationV1 } from '@/daemon/connectedServices/runsBridge/contract';

export type ExecutionRunManagerStartParams = Readonly<{
  sessionId: string;
  startRequestId?: string;
  /** Host-computed digest of the effective wire start request; never supplied by callers directly. */
  startRequestFingerprint?: string;
  intent: ExecutionRunIntent;
  backendTarget: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  instructions?: string;
  /**
   * Optional model selection for the run's backend — SAME canonical shape as session spawn's
   * `modelId`. Threaded to the spawned backend; absent keeps the backend's default model.
   */
  modelId?: string;
  /**
   * Optional canonical config-option overrides for the run (e.g. `reasoning_effort`), SAME shape as
   * session spawn's `sessionConfigOptionOverrides`. Threaded to the spawned backend; absent keeps
   * the backend's configured defaults.
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  /**
   * Intent-scoped configuration. The execution-run substrate treats this as opaque,
   * but backends/engines may interpret it (e.g. native review CLIs like CodeRabbit).
   */
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  launchOrigin?: ExecutionRunLaunchOrigin;
  permissionMode: string;
  retentionPolicy: 'ephemeral' | 'resumable';
  runClass: 'bounded' | 'long_lived';
  ioMode: 'request_response' | 'streaming';
  profileId?: string | null;
  /**
   * Daemon-materialized connected-services env for this run (e.g. `CODEX_HOME`), resolved at the
   * RPC start layer via the ER-CS daemon bridge. Merged generically into the run backend's isolation
   * bundle; absent means the run keeps default (runner-inherited) behavior.
   */
  connectedServicesEnv?: Readonly<Record<string, string>> | null;
  /** Idempotent run-end release for the daemon-side CS registration + materialized root. */
  connectedServicesCleanup?: (() => Promise<void>) | null;
  /**
   * The canonical connected-service selection actually materialized for this run at start (resolved
   * by the RPC-layer CS owner). Persisted verbatim in the run's immutable launch record so a resume
   * can re-materialize the SAME account/profile. Binding metadata only — never tokens/env values.
   */
  connectedServicesSelection?: ConnectedServiceBindingsV1 | null;
  connectedServicesRegistration?: ExecutionRunConnectedServiceRegistrationV1 | null;
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
  startRequestId?: string;
  startRequestFingerprint?: string;
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
  /**
   * Immutable launch record: the re-resolvable launch intent captured at start so every resume
   * recreates the backend with the SAME model, config overrides, and connected-service account
   * instead of falling back to ambient/native auth and default model. Contains only safe,
   * re-resolvable inputs — NEVER raw credentials, materialized env values, or closures.
   */
  launch?: Readonly<{
    launchOrigin?: ExecutionRunLaunchOrigin;
    modelId?: string;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    connectedServicesSelection?: ConnectedServiceBindingsV1 | null;
    connectedServicesRegistration?: ExecutionRunConnectedServiceRegistrationV1 | null;
  }>;
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
