import type { RunTerminalRemoteSessionModeLoopOptions } from './runTerminalRemoteSessionModeLoop';

export type HostSessionTerminalRemoteHandoffReason =
  | 'pending_queue_after_terminal_boundary'
  | 'switch_now';

export type HostSessionTerminalRemoteHandoffResult = Readonly<{
  ok: boolean;
  detail?: string;
}>;

export type HostSessionTerminalRemoteResumeReadiness = Readonly<{
  ready: boolean;
  detail?: string;
}>;

export type HostSessionTerminalRemoteModeLoop = RunTerminalRemoteSessionModeLoopOptions & Readonly<{
  /** Local-control ownership used by the pending-input handoff owner. */
  topology?: 'exclusive' | 'shared';
  /** A shared provider session can remain writable from Happier while its CLI is attached. */
  remoteWritable?: boolean;
  /** The local pass uses this runner's stdio, so the host display must yield it. */
  ownsCurrentTerminalDisplay?: boolean;
  getResumeReadiness?: () => HostSessionTerminalRemoteResumeReadiness;
  /** The admitted runtime's optional provider presenter for the existing Agent-terminal viewer. */
  openAgentTerminalPresentation?: (signal?: AbortSignal) => Promise<Readonly<{
    terminalId: string;
    fresh: boolean;
  }> | null>;
  requestGracefulRemoteHandoff?: (
    reason: HostSessionTerminalRemoteHandoffReason,
  ) =>
    | HostSessionTerminalRemoteHandoffResult
    | boolean
    | void
    | Promise<HostSessionTerminalRemoteHandoffResult | boolean | void>;
}>;
