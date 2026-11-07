import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { ManagedActivityReasonV1Schema } from '../../../machines/managed/activityDecisionV1.js';
import { ActionOperationIdentifierV1Schema } from '../../operations/identifierV1.js';
import { MachineElevatedResultV1Schema } from '../../../machines/adminAccessV1.js';
import { MachineVitalsHostFactsV1Schema } from '../../../machines/vitals/machineVitalsSampleV1.js';
import { RPC_METHODS } from '../../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../../actionSpecs.js';
export { MACHINE_REBOOT_ACTION_IDS } from '../../../machines/rebootActionIdsV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const operation = lazyZodSchema(() => z.strictObject({ operationId: ActionOperationIdentifierV1Schema }));
export const MachineRebootInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id(), machineId: id(), expectedInstallationId: id(),
}));
export type MachineRebootInputV1 = z.infer<typeof MachineRebootInputV1Schema>;
/** Domain receipt only. Existing Action operations own acceptance and settlement. */
export const MachineRebootResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('blocked'),
    reasons: z.array(ManagedActivityReasonV1Schema).check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('accepted'), operation, bootedAt: MachineVitalsHostFactsV1Schema.def.shape.bootedAt }),
  z.strictObject({ kind: z.literal('failed'), reasonCode: MachineElevatedResultV1Schema.def.options[1].def.shape.reasonCode }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['admission_unavailable', 'required_fact_unavailable',
    'daemon_draining', 'daemon_shutting_down', 'needs_attendance']) }),
]));
export type MachineRebootResultV1 = z.infer<typeof MachineRebootResultV1Schema>;
function createMachineRebootActionSpecs() {
  return [{
  id: 'machines.reboot', title: 'Reboot Machine',
  description: 'Reboot this exact installation only after fresh maintenance admission and administrator authorization.',
  approval: { result: 'required' }, approvalScope: 'machine', approvalPolicy: { uiConfirmation: 'policy' },
  safety: 'danger', sideEffectClass: 'danger', executionPlacement: 'machine', placements: [],
  operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
  toolExposure: { agent: 'discoverable_only' },
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { rpcMethod: RPC_METHODS.MACHINES_REBOOT, mcpToolName: 'machines_reboot' },
  inputSchema: MachineRebootInputV1Schema, outputSchema: MachineRebootResultV1Schema,
  cli: { acceptsServerId: true, commands: [{ path: ['machines', 'reboot'], visibility: 'canonical' }] },
  inputHints: { fields: [
    { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
    { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
    { path: 'expectedInstallationId', title: 'Reviewed installation ID', widget: 'text', required: true },
  ] },
}] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_REBOOT_ACTION_SPECS: ReturnType<typeof createMachineRebootActionSpecs> = lazyActionSpecArray(createMachineRebootActionSpecs);
