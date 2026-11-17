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

/** The declaration selects a log source; the retained occurrence binds its native generation. */
export type LocalServiceLogOccurrence = Readonly<{
  machineId: string;
  serviceId: string;
  expectedGeneration: string;
  name: string;
}>;
