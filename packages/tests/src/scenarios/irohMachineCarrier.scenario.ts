import type { MachineCarrierOperationKind } from '../../../../apps/cli/src/daemon/peer/iroh/machineCarrier';

export const IROH_MACHINE_CARRIER_FLOWS: readonly MachineCarrierOperationKind[] = [
  'file_transfer', 'attachment_transfer', 'workspace_sync',
];
