import type { PluginActionResultById } from './actionTypeMap.generated.js';

/** Public source copies are the canonical target Plan's accepted source contract. */
export type MachineSetupSourceV1 = Extract<PluginActionResultById['machines.setup.plan'], { sources: unknown }>['sources'];
export type MachineSetupSourceEntryV1 = MachineSetupSourceV1[number];
