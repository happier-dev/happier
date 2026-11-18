
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_TERMINAL_ACTION_IDS = [
  'machines.terminal.open', 'machines.terminal.list', 'machines.terminal.read',
  'machines.terminal.write', 'machines.terminal.close', 'machines.terminal.restart',
] as const;

/** Open/restart can prepare a Project shell; interactive IO retains terminal custody. */
export function isMachineTerminalOpenOrRestartActionIdV1(value: string): value is 'machines.terminal.open' | 'machines.terminal.restart' {
  return value === 'machines.terminal.open' || value === 'machines.terminal.restart';
}

export type MachineTerminalStreamActionIdV1 = 'machines.terminal.read' | 'machines.terminal.write';

/** Stream I/O on an already admitted PTY: read and write carry no review of their own. */
export function isMachineTerminalStreamActionIdV1(value: string): value is MachineTerminalStreamActionIdV1 {
  return value === 'machines.terminal.read' || value === 'machines.terminal.write';
}
