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
} as const satisfies Partial<Record<CoreMachineRoleIdV1, readonly string[]>>;

export type SplitMachineRoleId = keyof typeof MACHINE_ROLE_RPC_NAMESPACES;
export const SPLIT_MACHINE_ROLE_IDS = Object.keys(MACHINE_ROLE_RPC_NAMESPACES) as SplitMachineRoleId[];
