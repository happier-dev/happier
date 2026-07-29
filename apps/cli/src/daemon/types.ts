/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { ChildProcess } from 'child_process';
import type { AgentSessionStartupInstructionsMarkerV1 } from '@happier-dev/protocol';
import type {
  ManagedLocalServiceRunAttachmentMarkerOwnership,
  ManagedLocalServiceRunAttachmentV1,
} from './sessionRegistry';
import type { CancelStartupLaunch } from './spawn/startupLaunchCancellation';
import type {
  ExactWindowsProcessCancellationIdentity,
  WindowsTerminalLaunchCustody,
} from './platform/windows/windowsProcessCustody';

export type DaemonSpawnStartupReadinessFailure = Extract<
  SpawnSessionResult,
  { type: 'error' }
>;

export type { AgentSessionStartupInstructionsMarkerV1 };

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  /** Exact currently open runtime turn. Persisted marker state is authoritative. */
  activeTurnId?: string;
  /**
   * A turn that was active when a prior daemon incarnation stopped observing
   * this runner. It is exit-settlement evidence only and must never be used as
   * current activity or as an input-admission decision.
   */
  reattachedInterruptedTurnId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  /** Spawn options used to start the current runner process (in-memory only). */
  spawnOptions?: SpawnSessionOptions;
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
  /**
   * Exact managed local-service attachment persisted with this spawn's marker.
   * Its presence makes placeholder-to-canonical marker adoption part of the
   * required managed bootstrap acknowledgement.
   */
  managedLocalServiceRunAttachment?: ManagedLocalServiceRunAttachmentV1;
  /** Transfers exact marker cleanup custody when a wrapper PID is promoted. */
  onManagedLocalServiceMarkerPidPromoted?: (
    input: Readonly<{
      fromPid: number;
      toPid: number;
      ownership: ManagedLocalServiceRunAttachmentMarkerOwnership;
      processCommand?: string;
    }>,
  ) =>
    | boolean
    | 'attachment_cleared'
    | Promise<boolean | 'attachment_cleared'>;
  /**
   * In-memory-only fresh-session activation that consumes the canonical server
   * session id reported by the child before startup is acknowledged.
   */
  activateConnectedAccountSessionBindingOnCanonicalSession?: (
    sessionId: string,
  ) => Promise<DaemonSpawnStartupReadinessFailure | null>;
  /** Canonical identity locked by the first qualified fresh-session webhook. */
  spawnStartupCanonicalSessionId?: string;
  /**
   * Original PID key owning the in-flight webhook waiter after a verified
   * wrapper-to-runner promotion.
   */
  spawnStartupAwaiterPid?: number;
  /** Current verified wrapper-to-runner marker/custody promotion, if any. */
  sessionMarkerPidPromotion?: Promise<boolean>;
  /** Joins duplicate canonical Windows Terminal webhooks to one reconciliation. */
  windowsTerminalCanonicalWebhookReconciliation?: Promise<void>;
  /** Exact idempotent pre-ACK retirement owned by this startup attempt. */
  cancelStartupLaunchBeforeAck?: CancelStartupLaunch;
  /** Required startup failure returned through the original spawn awaiter. */
  spawnStartupReadinessFailure?: DaemonSpawnStartupReadinessFailure;
  /** Daemon-issued authorization allowing a spawned runner to use the plugin local-services bridge. */
  localServicesBridgeTokenHash?: string;
  /** Owning plugin id authorized for the plugin local-services bridge token. */
  localServicesBridgePluginId?: string;
  /** Backend/contribution id authorized for the plugin local-services bridge token. */
  localServicesBridgeContributionId?: string;
  /** Token file path issued to the spawned child. The marker keeps this for daemon restart reattach. */
  localServicesBridgeTokenFilePath?: string;
  /** In-memory-only capability for the daemon-owned native Agent session runtime. */
  agentRuntimeBridgeTokenHash?: string;
  agentRuntimeBridgePluginId?: string;
  agentRuntimeBridgeAgentId?: string;
  agentRuntimeBridgeBackendId?: string;
  agentRuntimeBridgeGeneration?: string;
  /** Vendor resume id (e.g. Claude/Codex session id) supplied/derived at spawn time. */
  vendorResumeId?: string;
  /**
   * Expected terminal host metadata for visible daemon launches.
   * Windows Terminal uses its daemon-issued unique tab title to correlate the
   * command-sender host PID with the Agent PID reported by the webhook.
   */
  hostedTerminal?: Metadata['terminal'];
  /** In-memory-only exact packaged executable/argv evidence for one Windows Terminal launch. */
  windowsTerminalLaunchCustody?: WindowsTerminalLaunchCustody;
  /** In-memory-only exact Agent tree cancellation target captured from the canonical webhook. */
  windowsTerminalCancellationIdentity?: ExactWindowsProcessCancellationIdentity;
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
  /**
   * Set when a daemon-owned spawn times out before the runner has reported a
   * canonical session id. Late webhooks from this process must be ignored so a
   * timed-out spawn cannot materialize a hidden session or poison retry.
   */
  sessionWebhookTimedOutAtMs?: number;
  /**
   * Hash of the observed process command line for PID reuse safety.
   * If present, we require this to match before sending SIGTERM by PID.
   */
  processCommandHash?: string;
  /** Canonical OS process birth timestamp paired with PID and command hash. */
  processStartTimeMs?: number;
  /** Best-effort observed process command line used for startup runtime refresh checks. */
  processCommand?: string;
  childProcess?: ChildProcess;
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
   * A surviving native Agent runtime cannot be rebound after daemon restart:
   * its bridge handle, generation lease, effects, and request state were
   * process-local. Keep the exact runner fenced while refusing reuse.
   */
  agentRuntimeRestartDisposition?: 'bridge_authority_unavailable';
  /**
   * Set when the daemon requests the session runner to stop (SIGTERM dispatched). Used as a
   * coordination hint so "resume/restart" requests can wait for the runner to fully exit instead
   * of racing the in-flight stop.
   */
  stopRequestedAtMs?: number;
  /**
   * Exact nested terminal attachment whose servable projection this daemon has published.
   * Prevents repeated capability probes when the runner reports unrelated metadata later.
   */
  publishedTerminalControlServiceabilityAttachmentId?: string;
}
