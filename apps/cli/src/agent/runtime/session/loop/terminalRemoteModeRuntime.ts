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
  getResumeReadiness?: () => HostSessionTerminalRemoteResumeReadiness;
  requestGracefulRemoteHandoff?: (
    reason: HostSessionTerminalRemoteHandoffReason,
  ) =>
    | HostSessionTerminalRemoteHandoffResult
    | boolean
    | void
    | Promise<HostSessionTerminalRemoteHandoffResult | boolean | void>;
}>;
