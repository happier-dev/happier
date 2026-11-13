import type { CoreMachineRoleIdV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

/**
 * Machine RPC namespaces owned by a role whose entry has been split out of machine core.
 * The role entry registers these handlers when it is activated; machine core registers none
 * of them. While a role is inactive, a call into its namespace answers the typed role refusal.
 * Roles not listed here are still registered by machine core (see P03-HANDLER-SPLIT).
 */
export const MACHINE_ROLE_RPC_NAMESPACES = {
  memory: ['daemon.memory.'],
  voice: ['daemon.voiceInference.', 'daemon.voiceDiagnostics.'],
  devices: ['daemon.computer.', 'daemon.browser.', 'daemon.devices.'],
  // No Machine RPC family: brokered requests arrive over the peer carrier, and placement follows
  // the `providerBrokerIngress` advertisement the role withdraws when it stops.
  broker: [],
  // Starting new Sessions on this Machine (spawn, spawn-new, fork, continue-with-replay, server
  // start, creation preparation, continuation reads). Stop and running-Session control stay in
  // machine core: turning sessions off lets running Sessions finish and refuses new ones.
  sessions: [
    'daemon.sessionCreation.', 'daemon.sessions.serverStart.', 'spawn-happy-session', 'session.spawnNew',
    'session.fork', 'session.continueWithReplay', 'session.continuation.', 'session.agentTransition.',
  ],
} as const satisfies Partial<Record<CoreMachineRoleIdV1, readonly string[]>>;

export type SplitMachineRoleId = keyof typeof MACHINE_ROLE_RPC_NAMESPACES;
export const SPLIT_MACHINE_ROLE_IDS = Object.keys(MACHINE_ROLE_RPC_NAMESPACES) as SplitMachineRoleId[];

/**
 * Local control-socket routes owned by a split role (the control half of the same registration
 * seam): while the role is inactive they answer the same `machine_role_inactive` refusal.
 */
export const MACHINE_ROLE_CONTROL_ROUTES = {
  // New Sessions over the local control socket. Execution-run admission stays core: it is the work
  // of an already-running Session, which may finish.
  sessions: ['/spawn-session', '/continue-with-replay'],
} as const satisfies Partial<Record<SplitMachineRoleId, readonly string[]>>;
