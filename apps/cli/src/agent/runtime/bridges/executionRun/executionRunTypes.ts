import type {
  AcpConfigOptionOverridesV1,
  BackendTargetRefV1,
  ConnectedServiceBindingsV2,
  ExecutionRunDisplay,
  ExecutionRunIntent,
  ExecutionRunInitialInputV1,
  ExecutionRunLaunchOrigin,
  ExecutionRunRequestedConfiguration,
  ExecutionRunResumeHandle,
  ExecutionRunConnectedServicesLaunchV1,
  ExecutionRunResultContractV1,
  HappierStructuredInputV1,
  ProviderBoundModelRef,
  PortableRuntimeDescriptorV1,
  SessionInputCausalPermissionAuthorityV1,
  SessionMcpSelectionV1,
  SecretReferenceOverlayV1,
  TeamCredentialProviderModelSelectionV1,
} from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import type { DurableProviderInputAcceptanceV1 } from '@/agent/runtime/session/input/providerInputOutcome';
import type {
  ExecutionRunStructuredMeta,
  ExecutionRunStructuredOutputRecovery,
} from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunPermissionRequestStoreProvider } from './executionRunPermissionResponseTarget';
import type { ExecutionRunWorkflowObservationSink } from './executionRunWorkflowObservation';

export type ExecutionRunManagerStartParams = Readonly<{
  /** Session association is explicit; `null` is a daemon-owned detached run. */
  sessionId: string | null;
  /** Absolute depth stamped by host admission; parent refs are correlation only. */
  workDepth?: number;
  /** Host-only store bound to this exact Run occurrence when it differs from the bridge default. */
  getPermissionRequestStore?: ExecutionRunPermissionRequestStoreProvider;
  /** Host-private exact Workflow invocation projection; never persisted with Run state. */
  workflowObservationSink?: ExecutionRunWorkflowObservationSink;
  /** Host-private identity from an admitted Workflow Action leaf, never authored input. */
  workflowRunId?: string;
  intent: ExecutionRunIntent;
  roleId?: string;
  launchProfileId?: string;
  /** Host-resolved admission snapshot, never a caller-authored RPC field. */
  resolvedRole?: import('@happier-dev/protocol').ResolvedRoleV1;
  roleSessionMetadata?: unknown;
  promptCredentials?: import('@/persistence').StoredCredentials;
  backendTarget: BackendTargetRefV1;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  instructions?: string;
  /** Explicit attached-run creation without an initial turn. */
  initialInput?: ExecutionRunInitialInputV1;
  /** Host-derived reviewer provenance; never admitted from a public Run request. */
  reviewNarration?: Readonly<{ phase: 'writing'; provenance: import('@happier-dev/protocol').ScmDiffSummaryReviewProvenance }>;
  /** Host-stamped Action identity used only to rejoin the same accepted start. */
  actionRequestId?: string;
  /**
   * Intent-scoped configuration. The execution-run substrate treats this as opaque,
   * but execution-run profiles and backends may interpret it.
   */
  intentInput?: unknown;
  /** Canonical host-owned structured input for the initial native turn. */
  structuredInput?: HappierStructuredInputV1;
  /** Stable authored identity for the initial input; never regenerated downstream. */
  localInputId?: string;
  /** Exact contract for the initial turn only; later sends carry their own. */
  resultContract?: ExecutionRunResultContractV1;
  /** Per-Run cwd selected by the workspace owner. */
  cwd?: string;
  /** Canonical managed MCP selection for this Run. */
  mcpSelection?: SessionMcpSelectionV1;
  acpSessionModeId?: string;
  runtimeDescriptorV1?: PortableRuntimeDescriptorV1;
  display?: ExecutionRunDisplay;
  launchOrigin?: ExecutionRunLaunchOrigin;
  /**
   * Optional connected-services selection for the run backend. Omitted (undefined) means
   * "apply the session-spawn account-settings defaulting"; null means "explicitly native".
   * Connected selections fail closed at backend resolution when the daemon cannot
   * resolve + materialize the selected auth.
   */
  connectedServices?: ConnectedServiceBindingsV2 | null;
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
  /** Exact recipient-safe Team resource/model tuple for this run. */
  teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
  /**
   * Optional canonical agent config-option overrides (e.g. reasoning effort) for the run backend,
   * reusing the SAME `AcpConfigOptionOverridesV1` shape as session spawn. The `configOptions`
   * shorthand is merged into this at the action boundary before the run request is built.
   */
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  secretReferenceOverlay?: SecretReferenceOverlayV1;
  /**
   * Host-only active-turn authority for this initial launch. It is purposely
   * absent from persisted run state, so a later resume cannot inherit a stale
   * turn's admission ceiling.
   */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  retentionPolicy: 'ephemeral' | 'resumable';
  runClass: 'bounded' | 'long_lived';
  ioMode: 'request_response' | 'streaming';
  notifyParentOnCompletion?: boolean;
  profileId?: string | null;
  profileSourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1 | null;
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
  requestedConfiguration?: ExecutionRunRequestedConfiguration;
}>;

export type ExecutionRunRuntimeSettings = Readonly<{
  accountSettings?: Readonly<Record<string, unknown>>;
}>;

export type ExecutionRunState = Readonly<{
  /** Resolved host runtime engine, rather than a requested launch preference. */
  effectiveEngine?: Readonly<{ agentId: string; modelId?: string }>;
  runId: string;
  callId: string;
  sidechainId: string;
  /** Immutable host-stamped Workflow parent; independent of a watched Session. */
  originWorkflowRunId?: string;
  sessionId: string | null;
  depth: number;
  intent: ExecutionRunManagerStartParams['intent'];
  roleId?: string;
  launchProfileId?: string;
  profileId?: string | null;
  profileSourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1 | null;
  backendTarget: BackendTargetRefV1;
  backendId: string;
  instructions: string;
  intentInput?: unknown;
  display?: ExecutionRunDisplay;
  permissionMode: string;
  workspaceWrites?: 'allow' | 'deny';
  retentionPolicy: ExecutionRunManagerStartParams['retentionPolicy'];
  runClass: ExecutionRunManagerStartParams['runClass'];
  ioMode: ExecutionRunManagerStartParams['ioMode'];
  notifyParentOnCompletion?: boolean;
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
    cwd?: string;
    mcpSelection?: SessionMcpSelectionV1;
    acpSessionModeId?: string;
    runtimeDescriptorV1?: PortableRuntimeDescriptorV1;
    launchOrigin?: ExecutionRunLaunchOrigin;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    connectedServicesSelection?: ConnectedServiceBindingsV2 | null;
    /**
     * The Run's own Agent for `connectedServicesSelection`, recorded with the
     * resolved selection before materialization. Runtime-only: it lets the Run
     * owner attest its selection while its registration does not yet exist.
     */
    connectedServicesSelectionAgent?: import('@happier-dev/protocol').PluginContributionIdentityV1;
    connectedServicesRegistration?: ExecutionRunConnectedServicesLaunchV1;
    secretReferenceOverlay?: SecretReferenceOverlayV1;
  }>;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';
  startedAtMs: number;
  finishedAtMs?: number;
  error?: { code: string; message?: string };
  summary?: string;
  structuredMeta?: ExecutionRunStructuredMeta;
  latestToolResult?: unknown;
  /** Canonical current/last exact input result retained beyond controller settlement. */
  inputTurns?: Readonly<{
    occurrenceId: string;
    current?: import('@happier-dev/protocol').ExecutionRunInputTurnV1;
    last?: import('@happier-dev/protocol').ExecutionRunInputTurnV1;
  }>;
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
    voicePolicy?: import('@happier-dev/protocol').ExecutionRunVoiceAgentIntentInputV1['voicePolicy'];
    initialContextMode: 'bootstrap' | 'first_turn';
    verbosity: 'short' | 'balanced';
    bootstrapTimeoutMs?: number;
    disabledActionIds: readonly string[];
    transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  }>;
}>;

export type RetainedRunSessionInputAttachment = Readonly<{
  release: () => Promise<void>;
  /** Event-driven durable outcome for one exact Pending input identity. */
  awaitInputAdmission: (localId: string) => Promise<DurableProviderInputAcceptanceV1>;
}>;

/** Binds a retained Session-owned Run occurrence to the parent Session input owner. */
export type AttachRetainedRunSessionInput = (params: Readonly<{
  runId: string;
  sidechainId: string;
  controller: ExecutionRunBackendController;
}>) => RetainedRunSessionInputAttachment | null;

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
