import { createHappierCollectionVisitMemory } from '@happier-dev/plugin-ui/presentation';
import type { MachineCollectionTarget } from './machineCollectionModel';

/** The machine last opened in the Machines collection during this app session; a wide collection lands on it. */
const machineVisits = createHappierCollectionVisitMemory<MachineCollectionTarget & Readonly<{ query?: string }>>();

export const recordMachineCollectionVisit = machineVisits.record;
export const readLastVisitedMachine = machineVisits.read;
