import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { useSessionTerminalActionExecute } from '@/components/sessions/terminal/useSessionTerminalWorkspace';

/** Attach retained supervisor output through the existing terminal presentation Action. */
export function openLocalServiceTerminal(
  target: LocalServiceLaunchTarget,
  execute: ReturnType<typeof useSessionTerminalActionExecute>,
) {
  return target.terminalView
    ? execute('session.terminals.open', { target: target.terminalView })
    : Promise.resolve(null);
}

/** Retained native generation and, when supplied by its launcher, the exact serving checkout. */
export type LocalServiceLogOccurrence = Readonly<{
  machineId: string;
  serviceId: string;
  expectedGeneration: string;
  name: string;
  workspace?: LocalServiceLaunchTarget['workspace'];
  restartTarget?: LocalServiceLaunchTarget;
}>;
