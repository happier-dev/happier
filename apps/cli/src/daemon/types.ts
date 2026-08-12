/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { ChildProcess } from 'child_process';

export type TerminalHostHealthState = Readonly<{
  status: 'host_dead';
  sessionId: string;
  runnerPid: number;
  hostKind: 'zellij' | 'tmux' | 'pty' | string;
  zellijSessionName?: string;
  observedAt: number;
  reason: string;
}>;

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  /** Spawn options used to start the current runner process (in-memory only). */
  spawnOptions?: SpawnSessionOptions;
  /** Vendor resume id (e.g. Claude/Codex session id) supplied/derived at spawn time. */
  vendorResumeId?: string;
  /** Exact session-owned foreground turn currently open in this runner. */
  activeTurnId?: string;
  /**
   * Expected terminal host metadata for visible/hosted daemon launches.
   * Used to correlate wrapper host PIDs (for example wt.exe) with the child session runner webhook.
   */
  hostedTerminal?: Metadata['terminal'];
  pid: number;
  /**
   * When the daemon spawns a wrapper script that then spawns the actual runner
   * process, the session webhook reports the runner PID (child) while the daemon
   * tracks the wrapper PID (parent). This field stores the runner PID when known.
   */
  sessionRunnerPid?: number;
  /**
   * Hash of the observed process command line for PID reuse safety.
   * If present, we require this to match before sending SIGTERM by PID.
   */
  processCommandHash?: string;
  /** Exact OS process-instance fingerprint used to distinguish PID generations. */
  processInstanceFingerprint?: string;
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
  terminalHostHealth?: TerminalHostHealthState;
}
