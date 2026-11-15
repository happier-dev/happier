import { hasHostedAttachedTerminalPresentation } from '@/agent/localControl/createAttachedTerminalSupervisor';
import { resolvePiLaunchSelectionFromConnectedServiceSelection } from '@/backends/pi/acp/backend';
import { PI_BROKER_SELECTIONS_ENV } from '@/backends/pi/brokerExtension';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

export type PiSharedTerminalLaunch =
  | Readonly<{ kind: 'shared' }>
  /** `connected_service`: the run would otherwise be shared; Batch 1 keeps brokered credentials on RPC. */
  | Readonly<{ kind: 'rpc'; fallback: 'connected_service' | null }>;

/**
 * `happier pi` from a user's own terminal runs Pi's native TUI with the Happier bridge. Every
 * other start (daemon, no TTY, a hosted tmux/herdr/zellij pane) keeps the RPC child.
 */
export function resolvePiSharedTerminalLaunch(params: Readonly<{
  startedBy: 'daemon' | 'terminal' | undefined;
  hasTTY: boolean;
  terminalRuntime: TerminalRuntimeFlags | null | undefined;
  env: Readonly<NodeJS.ProcessEnv>;
}>): PiSharedTerminalLaunch {
  if (params.startedBy !== 'terminal' || !params.hasTTY) return { kind: 'rpc', fallback: null };
  if (hasHostedAttachedTerminalPresentation(params.terminalRuntime)) return { kind: 'rpc', fallback: null };
  const brokerSelections = params.env[PI_BROKER_SELECTIONS_ENV];
  if (
    (typeof brokerSelections === 'string' && brokerSelections.trim() !== '')
    || resolvePiLaunchSelectionFromConnectedServiceSelection(params.env) !== null
  ) {
    return { kind: 'rpc', fallback: 'connected_service' };
  }
  return { kind: 'shared' };
}
