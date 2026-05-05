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

export type HostSessionTerminalRemoteModeRuntime = Readonly<{
  resolveTerminalRemoteSessionModeLoop: () => HostSessionTerminalRemoteModeLoop | null | undefined;
}>;

function isTerminalRemoteModeLoop(value: unknown): value is HostSessionTerminalRemoteModeLoop {
  if (!value || typeof value !== 'object') return false;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.remoteExitCode === 'number'
    && typeof record.runTerminal === 'function'
    && typeof record.runRemote === 'function'
    && typeof record.onModeChange === 'function';
}

export function resolveHostSessionTerminalRemoteModeLoop(runtime: unknown): HostSessionTerminalRemoteModeLoop | null {
  if (!runtime || typeof runtime !== 'object') return null;
  const resolver = (runtime as Readonly<Record<string, unknown>>).resolveTerminalRemoteSessionModeLoop;
  if (typeof resolver !== 'function') return null;

  const resolved = (resolver as HostSessionTerminalRemoteModeRuntime['resolveTerminalRemoteSessionModeLoop']).call(runtime);
  if (resolved == null) return null;
  if (!isTerminalRemoteModeLoop(resolved)) {
    throw new Error('Terminal remote session mode runtime returned an invalid loop definition');
  }
  return resolved;
}
