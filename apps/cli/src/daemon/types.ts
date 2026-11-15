/**
 * Daemon-specific types (not related to API/server communication)
 */

import type { SessionHeldAgentV1 } from '@/subprocess/supervision/sessionHolder';
import { Metadata, type SessionCreationOutcome } from '@/api/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { ChildProcess } from 'child_process';
import type { ProcessIdentityWitness } from '@happier-dev/cli-common/processInstance';
import type {
  AgentSessionStartupInstructionsMarkerV1,
  PluginSourceCustodyV1,
  SessionRunnerStartingModeV1,
} from '@happier-dev/protocol';
import type { CancelStartupLaunch } from './spawn/startupLaunchCancellation';
import type {
  ExactWindowsProcessCancellationIdentity,
  WindowsTerminalLaunchCustody,
} from './platform/windows/windowsProcessCustody';
import type {
  AgentRuntimeDaemonServiceSessionOpenAttestationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import type {
  AgentRuntimeDaemonSessionDescriptorV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import type {
  RunnerManagedDependencyRetentionV1,
} from '@/plugins/runtime/runner/runnerManagedDependencyRetention';
import type {
  BoundAgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';
import type { RequesterWorkAttributionV1 } from './lifecycle/requesterWorkAttribution';
import type { RequesterSessionRuntimeContext } from './sessionEncryption/requesterSessionCredentials';
import type { OwnerRemainderCapture, OwnerRemainderResult } from './processes/endOwnerRemainder';
import type { ConnectedServiceMaterializedStateObservationBinding } from './connectedServices/materialization/materializer';
import type { ChildExit } from './sessions/onChildExited';
import type { SessionTrackingKey } from './sessions/sessionTrackingKey';

export type DaemonSpawnStartupReadinessFailure = Extract<
  SpawnSessionResult,
  { type: 'error' }
>;

export type { AgentSessionStartupInstructionsMarkerV1 };

export type RunnerAgentInvocationContext = Readonly<{
  cwd: string;
    /** Value-free launch selection, retained by host custody rather than child environment. */
    profileId?: string;
    secretReferenceOverlay?: import('@happier-dev/protocol').SecretReferenceOverlayV1;
  /** Stable daemon-service context only; launch-time secret material is never retained here. */
  environment: Readonly<Record<string, string>>;
  /** Exact non-secret Agent CLI launch selected during spawn/admission. */
  agentCliLaunch?: BoundAgentCliLaunchSpec;
  /** Provider launch binding is runner-owned and is rematerialized by live daemon service owners. */
  providerBindingActive: boolean;
}>;

/**
 * Non-secret, in-memory projection of the host-issued runner bootstrap
 * descriptor. It binds the first daemon-service grant to the concrete Agent
 * runtime selected during spawn; it is never marker-persisted.
 */
export type RunnerAgentBootstrapIdentity = Readonly<
  Pick<AgentRuntimeDaemonSessionDescriptorV1, 'agentId' | 'backendId'>
>;

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  /** Daemon-issued Session identity; the tracked map and the Session marker are keyed by it. */
  readonly trackingKey: SessionTrackingKey;
  /**
   * The plugin runtime registry the spawn that launched this Session still holds (null once that
   * spawn released its lease). In memory only; never marker-persisted.
   */
  readSpawnPluginRuntimeRegistry?: () => import('@/plugins/runtime/reload/controller').PluginRuntimeRegistryLease['registry'] | null;
  /** Original startup operation while the native Agent has not opened; never marker-persisted. */
  projectSetupOperation?: import('@/workspaces/projectSetup/projectSetupExecution').ProjectSetupOperationContext;
  /** Generation-bound pre-exit chain observations; ephemeral evidence, never marker-persisted. */
  ownerRemainderCapture?: OwnerRemainderCapture;
  /** Live private Account ports; never serialized in a marker or respawn descriptor. */
  requesterSessionRuntimeContext?: RequesterSessionRuntimeContext;
  /** Safe admitted launch facts, restored only through verified process adoption. */
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
  startedBy: 'daemon' | string;
  happySessionId?: string;
  /** Exact currently open runtime turn. Persisted marker state is authoritative. */
  activeTurnId?: string;
  /** Host-observed broker outcome for one admitted turn; never marker-persisted. */
  teamCredentialBrokerEvidence?: import('@/providers/broker/sessionBrokerApplicationEvidence').SessionBrokerApplicationEvidence;
  /** Requester reason for this occurrence's planned signal; diagnostics only, never persisted. */
  plannedRestartReason?: string;
  /** Request-owned planned-restart hold; read by the runner only to retire a lost cancellation. Never persisted. */
  plannedRestartAdmission?: import('./plannedRunnerRestart/sessionRunnerRestartAdmission').SessionRunnerRestartAdmissionAttempt;
  /**
   * A turn that was active when a prior daemon incarnation stopped observing
   * this runner. It is exit-settlement evidence only and must never be used as
   * current activity or as an input-admission decision.
   */
  reattachedInterruptedTurnId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  /**
   * Exact create-or-rejoin fact from this runner's immediate server transaction.
   * It stays in memory and is returned only to the matching spawn awaiter.
   */
  sessionCreationOutcome?: SessionCreationOutcome;
  /** Spawn options used to start the current runner process (in-memory only). */
  spawnOptions?: SpawnSessionOptions;
  /** Current runner's exact provider-input transport availability; absent on retained older runners. */
  providerInputAdmissionReady?: boolean;
  /**
   * Secret-free startup identity required by this session. It is persisted
   * before runtime open and does not prove that the runtime applied the raw
   * carrier.
   */
  agentSessionStartupInstructionsMarkerV1?: AgentSessionStartupInstructionsMarkerV1;
  /**
   * In-memory gate for a newly spawned child. Webhook correlation may update this
   * tracked object immediately, but durable/reporting effects wait for acceptance.
   */
  acceptedSpawnMarkerGate?: Promise<boolean>;
  /** Transient correlated marker-write custody; actual exit closes it before draining producers. */
  reportMarkerCustody?: { pending: Promise<void>; retiring: boolean };
  /** Transient startup completion consumed only by canonical actual-exit retirement. */
  startupCustody?: Readonly<{
    finalization: Promise<void>;
    observeExit: (exit: Readonly<ChildExit>) => void;
  }>;
  /**
   * In-memory-only fresh-session activation that consumes the canonical server
   * session id reported by the child before startup is acknowledged.
   */
  activateConnectedAccountSessionBindingOnCanonicalSession?: (
    sessionId: string,
  ) => Promise<DaemonSpawnStartupReadinessFailure | null>;
  /** Canonical identity locked by the first qualified fresh-session webhook. */
  spawnStartupCanonicalSessionId?: string;
  /** Current verified wrapper-to-runner marker/custody promotion, if any. */
  sessionMarkerPidPromotion?: Promise<boolean>;
  /** Joins duplicate canonical webhook reports to one startup reconciliation. */
  canonicalWebhookReconciliation?: Promise<void>;
  /** Exact idempotent pre-ACK retirement owned by this startup attempt. */
  cancelStartupLaunchBeforeAck?: CancelStartupLaunch;
  /** Required startup failure returned through the original spawn awaiter. */
  spawnStartupReadinessFailure?: DaemonSpawnStartupReadinessFailure;
  /**
   * Stable private path to the current per-session daemon-service authority
   * document. The marker stores no capability or broad daemon control token.
   */
  agentRuntimeDaemonServiceAuthorityFilePath?: string;
  /** In-memory-only digest for the current daemon-service scoped capability. */
  agentRuntimeDaemonServiceCapabilityHash?: string;
  /**
   * Exact host-issued bootstrap identity retained only until the first
   * daemon-service authority is installed for this fresh runner.
   */
  runnerAgentBootstrapIdentity?: RunnerAgentBootstrapIdentity;
  /** Exact non-secret source custody persisted in the exact runner marker. */
  runnerAgentSourceCustodyV1?: PluginSourceCustodyV1;
  /** Exact host-materialized state links; never accepted from spawn options or Session metadata. */
  materializedStateObservationBinding?: ConnectedServiceMaterializedStateObservationBinding;
  runnerManagedDependencyRetentionV1?:
    RunnerManagedDependencyRetentionV1;
  /**
   * In-memory-only launch facts authored by the daemon admission/spawn owner.
   * The environment may contain secrets and must never be marker-persisted.
   */
  runnerAgentInvocationContext?: RunnerAgentInvocationContext;
  /** Exact latest new-turn admission witness; never a second turn lifecycle owner. */
  agentRuntimeDaemonServiceAdmittedTurnId?: string;
  agentRuntimeDaemonServiceAdmittedInputId?: string;
  agentRuntimeDaemonServiceAdmittedUserMessageSeq?: number | null;
  agentRuntimeDaemonServiceAdmittedUserMessageSeqs?: number[];
  /** Live native input in exact runner/source custody; never serialized in a marker. */
  agentRuntimeDaemonServiceNativeRealtimeAdmission?: Readonly<{
    admission: import('@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness').NativeRealtimeInputAdmissionV1;
    runner: import('./agentRuntime/sessionBridgeAuthorization').AgentRuntimeDaemonServiceAuthorityRunnerIdentity;
    sourceCustody: PluginSourceCustodyV1;
  }>;
  /** Exact completed runner-owned sessions.open request for fork/open proof. */
  agentRuntimeDaemonServiceSessionOpenAttestation?:
    AgentRuntimeDaemonServiceSessionOpenAttestationV1;
  /** Vendor resume id (e.g. Claude/Codex session id) supplied/derived at spawn time. */
  vendorResumeId?: string;
  /** Agents this runner's holders keep (role-tagged; the marker persists them). */
  heldAgentsV1?: readonly SessionHeldAgentV1[];
  /** Set when this runner crashed and its held primary Agent was spared for the respawned runner to adopt. */
  sparedHeldAgentV1?: SessionHeldAgentV1 & Readonly<{ turnId?: string }>;
  /**
   * Expected terminal host metadata for visible daemon launches.
   * Windows Terminal uses its daemon-issued unique tab title to correlate the
   * command-sender host PID with the Agent PID reported by the webhook.
   */
  hostedTerminal?: Metadata['terminal'];
  /** In-memory-only exact packaged executable/argv evidence for one Windows Terminal launch. */
  windowsTerminalLaunchCustody?: WindowsTerminalLaunchCustody;
  /** Exact physical Linux scope basename; retained in the existing accepted-runner marker. */
  linuxLaunchUnit?: string;
  /** Same-address Guard receipt; only exact exit custody may publish observed stopped. */
  guardStopReceipt?: import('./guard/sessionStopReceipt').GuardSessionStopReceipt;
  /** In-memory-only runner generation and observed command captured by canonical session-report correlation. */
  runnerProcessIdentity?: Readonly<Required<ProcessIdentityWitness> & { processCommand?: string }>;
  /** One-shot in-memory bridge from exact webhook capture to the existing accepted-marker owner. */
  persistWindowsTerminalAcceptedAgentMarker?: (
    identity: ExactWindowsProcessCancellationIdentity,
  ) => Promise<void>;
  /** Exact target marker was accepted before canonical in-memory PID transfer. */
  windowsTerminalAcceptedTargetMarkerPersisted?: true;
  pid: number;
  /**
   * When the daemon spawns a wrapper script that then spawns the actual runner
   * process, the session webhook reports the runner PID (child) while the daemon
   * tracks the wrapper PID (parent). This field stores the runner PID when known.
   */
  sessionRunnerPid?: number;
  /** Observed private restart-admission refusal, valid only for this receiving runner PID. */
  runnerRestartAdmissionUnsupportedPid?: number;
  /**
   * Set when a daemon-owned spawn times out before the runner has reported a
   * canonical session id. Late webhooks from this process must be ignored so a
   * timed-out spawn cannot materialize a hidden session or poison retry.
   */
  sessionWebhookTimedOutAtMs?: number;
  /**
   * Legacy positive-classification witness and diagnostic snapshot. When a
   * process start time is available, command drift does not imply PID reuse.
   */
  processCommandHash?: string;
  /** Canonical OS process-generation witness paired with the PID. */
  processStartTimeMs?: number;
  /**
   * In-memory completion of the current canonical marker write. Foreground
   * authority promotion awaits this owner instead of racing or rewriting it.
   */
  sessionMarkerPersistence?: Promise<boolean>;
  /** Best-effort observed process command line used for startup runtime refresh checks. */
  processCommand?: string;
  /** Per-Session launch mode when the OS command belongs to a shared Session host. */
  sessionRunnerStartingMode?: SessionRunnerStartingModeV1;
  childProcess?: ChildProcess;
  /**
   * Set when this Session runs in the daemon's session host (`pid` is the host's): the host ends
   * it, never a signal to `pid`, which would end every Session of the host.
   */
  hostedSession?: Readonly<{
    /** Ask the host to end this Session; false when the host does not run it (any more). */
    end(): Promise<boolean>;
    /** Settles once this Session's end has been observed (exit custody settled). */
    observed: Promise<void>;
  }>;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
  /** tmux server tmpdir used for isolated tmux spawns (when provided). */
  tmuxTmpDir?: string;
  /**
   * Sessions reattached from disk markers after daemon restart are potentially unsafe to kill by PID
   * (avoids PID reuse killing unrelated processes). We keep them kill-protected.
   */
  reattachedFromDiskMarker?: boolean;
  /**
   * A surviving Runner Agent whose current daemon-service authority cannot be
   * verified remains fenced while its exact process is retired.
   */
  agentRuntimeRunnerRestartDisposition?: 'runner_authority_unavailable';
  /**
   * Set when the daemon requests the session runner to stop (SIGTERM dispatched). Used as a
   * coordination hint so "resume/restart" requests can wait for the runner to fully exit instead
   * of racing the in-flight stop.
   */
  stopRequestedAtMs?: number;
  /** Person-requested process Kill; uses the same stopping fact, never a restart intent. */
  stopRequestedReason?: 'user_process_kill';
  /** Result already produced by the final runner-exit owner for Stop to reuse. */
  ownerRemainderResult?: OwnerRemainderResult;
  /**
   * Exact nested terminal attachment whose servable projection this daemon has published.
   * Prevents repeated capability probes when the runner reports unrelated metadata later.
   */
  publishedTerminalControlServiceabilityAttachmentId?: string;
  /** Lifecycle of the exact attachment whose serviceability was published. */
  publishedTerminalControlServiceabilityAttachmentLifecycle?: 'owned' | 'borrowed';
}
