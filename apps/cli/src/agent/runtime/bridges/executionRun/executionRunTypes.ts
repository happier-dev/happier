import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV1,
  ExecutionRunDisplay,
  ExecutionRunIntent,
  ExecutionRunResumeHandle,
  ExecutionRunConnectedServicesLaunchV1,
  ProviderBoundModelRef,
  SessionInputCausalPermissionAuthorityV1,
} from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';

import type {
  ExecutionRunStructuredMeta,
  ExecutionRunStructuredOutputRecovery,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';

export type ExecutionRunManagerStartParams = Readonly<{
  /** Session association is explicit; `null` is a daemon-owned detached run. */
  sessionId: string | null;
  intent: ExecutionRunIntent;
  backendTarget: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  instructions?: string;
  /**
   * Intent-scoped configuration. The execution-run substrate treats this as opaque,
   * but execution-run profiles and backends may interpret it.
   */
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  /**
   * Optional connected-services selection for the run backend. Omitted (undefined) means
   * "apply the session-spawn account-settings defaulting"; null means "explicitly native".
   * Connected selections fail closed at backend resolution when the daemon cannot
   * resolve + materialize the selected auth.
   */
  connectedServices?: ConnectedServiceBindingsV1 | null;
  /**
   * Bare per-service default tokens (RO-F5): serviceIds asking for their STORED account default,
   * threaded from the run-start request alongside `connectedServices`. The run-start CS owner resolves
   * each to a concrete binding and merges it UNDER any explicit pin (explicit wins); a missing stored
   * default fails closed. Empty on resume — the persisted selection is already concrete.
   */
  connectedServicesDefaultServiceIds?: readonly string[];
  /**
   * Optional model selection for the run backend, mirroring session-spawn `modelId`. Threaded to
   * the plugin backend spawn through the unified runtime; per-provider application is plugin-owned.
   */
  modelId?: string;
  /** Exact re-resolvable Agent/Provider/model tuple for this run. */
  modelSelection?: ProviderBoundModelRef;
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) for the run backend,
   * reusing the SAME `AcpConfigOptionOverridesV1` shape as session spawn. The `configOptions`
   * shorthand is merged into this at the action boundary before the run request is built.
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  /**
   * Host-only active-turn authority for this initial launch. It is purposely
   * absent from persisted run state, so a later resume cannot inherit a stale
   * turn's admission ceiling.
   */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  permissionMode: string;
  retentionPolicy: 'ephemeral' | 'resumable';
  runClass: 'bounded' | 'long_lived';
  ioMode: 'request_response' | 'streaming';
  profileId?: string | null;
  profileGenerationId?: string | null;
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
  structuredOutputRecovery?: ExecutionRunStructuredOutputRecovery;
}>;

export type ExecutionRunStartResult = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
}>;

export type ExecutionRunRuntimeSettings = Readonly<{
  accountSettings?: Readonly<Record<string, unknown>>;
}>;

export type ExecutionRunState = Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  sessionId: string | null;
  depth: number;
  intent: ExecutionRunManagerStartParams['intent'];
  profileId?: string | null;
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
  runtimeSettings?: ExecutionRunRuntimeSettings;
  /**
   * Immutable launch record (LC-F2): the re-resolvable launch intent captured at start so every
   * backend recreation on resume rebuilds with the SAME model, config overrides, and connected-service
   * account instead of falling back to a bare backend on ambient/native auth + default model. Contains
   * only safe, re-resolvable inputs — the connected-service SELECTION, never raw credentials, resolved
   * env values, or closures. Dev materializes the selection daemon-side (fail-closed) at resume.
   */
  launch?: Readonly<{
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    connectedServicesSelection?: ConnectedServiceBindingsV1 | null;
    connectedServicesRegistration?: ExecutionRunConnectedServicesLaunchV1;
  }>;
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
    chatModelSelection?: ProviderBoundModelRef;
    commitModelSelection?: ProviderBoundModelRef;
    commitIsolation: boolean;
    permissionIntent: PermissionIntent;
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
