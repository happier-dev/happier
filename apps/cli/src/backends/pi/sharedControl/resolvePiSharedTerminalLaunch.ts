import { hasHostedAttachedTerminalPresentation } from '@/agent/localControl/createAttachedTerminalSupervisor';
import { resolvePiLaunchSelectionFromConnectedServiceSelection } from '@/backends/pi/acp/backend';
import { PI_BROKER_SELECTIONS_ENV } from '@/backends/pi/brokerExtension';
import type { TerminalRuntimeFlags } from '@/terminal/runtime/terminalRuntimeFlags';

export type PiSharedTerminalLaunch =
  | Readonly<{ kind: 'shared' }>
  /** `connected_service`: the run would otherwise be shared; Batch 1 keeps brokered credentials on RPC. */
  | Readonly<{ kind: 'rpc'; fallback: 'connected_service' | null }>;

/**
 * With native terminal enabled, `happier pi` can run Pi's TUI in the user's own terminal.
 * Other starts keep the RPC child.
 */
export function resolvePiSharedTerminalLaunch(params: Readonly<{
  nativeTerminalEnabled?: unknown;
  startedBy: 'daemon' | 'terminal' | undefined;
  hasTTY: boolean;
  terminalRuntime: TerminalRuntimeFlags | null | undefined;
  env: Readonly<NodeJS.ProcessEnv>;
}>): PiSharedTerminalLaunch {
  if (params.nativeTerminalEnabled !== true) return { kind: 'rpc', fallback: null };
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
