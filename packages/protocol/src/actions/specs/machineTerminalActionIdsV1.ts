
/** Action identity leaf: schema modules and the registry share these constants. */
export const MACHINE_TERMINAL_LIST_ACTION_ID_V1 = 'machines.terminal.list' as const;
export const MACHINE_TERMINAL_ACTION_IDS = [
  'machines.terminal.open', MACHINE_TERMINAL_LIST_ACTION_ID_V1, 'machines.terminal.read',
  'machines.terminal.write', 'machines.terminal.close', 'machines.terminal.restart',
] as const;

/** Open/restart can prepare a Project shell; interactive IO retains terminal custody. */
export function isMachineTerminalOpenOrRestartActionIdV1(value: string): value is 'machines.terminal.open' | 'machines.terminal.restart' {
  return value === 'machines.terminal.open' || value === 'machines.terminal.restart';
}

/** The finite Project script a package-script terminal launch runs, reviewed with its open/restart. */
export const MACHINE_TERMINAL_PACKAGE_SCRIPT_CHILD_V1 = Object.freeze({ action: 'projects.script.run', role: 'package_script' } as const);

export type MachineTerminalStreamActionIdV1 = 'machines.terminal.read' | 'machines.terminal.write';

/** Stream I/O on an already admitted PTY: read and write carry no review of their own. */
export function isMachineTerminalStreamActionIdV1(value: string): value is MachineTerminalStreamActionIdV1 {
  return value === 'machines.terminal.read' || value === 'machines.terminal.write';
}

/** Only an interactive viewer's read ends on Machine access loss, so only it may reuse one session admission. */
export function isMachineTerminalSessionReadActionIdV1(value: string): value is 'machines.terminal.read' {
  return value === 'machines.terminal.read';
}
