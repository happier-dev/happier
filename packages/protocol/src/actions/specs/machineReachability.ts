import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { MACHINE_REACHABILITY_ACTION_IDS_V1 } from '../../machines/reachability/actionIdsV1.js';
import { MachineReachabilityInspectInputV1Schema, MachineReachabilityInspectResultV1Schema,
  MachineReachabilityConfigureInputV1Schema, MachineReachabilityConfigureResultV1Schema } from '../../machines/reachability/actionsV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const MachineReachabilityActionIdV1Schema = lazyZodSchema(() => z.enum(MACHINE_REACHABILITY_ACTION_IDS_V1));
// API/Plugin exposure is derived by the canonical public-exposure owner.
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: true } as const;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;

/** The same nonsecret reviewed basis reaches ordinary approval presentation and replay. */
function projectConfigureObservationInput(value: unknown): unknown {
  const input = readRecord(value);
  return { ...(input.serverId === undefined ? {} : { serverId: input.serverId }), machineId: input.machineId,
    change: input.change, reviewedPlanDigest: input.reviewedPlanDigest,
    reviewedPlanBasis: input.reviewedPlanBasis };
}

export const MACHINE_REACHABILITY_ACTION_SPECS_V1 = [
  { id: 'machines.reachability.inspect', title: 'Inspect Machine reachability',
    description: 'Read selected network facts or prepare a proposed change without mutation or native admission.',
    approval: { result: 'required' }, approvalScope: 'machine', safety: 'safe', sideEffectClass: 'read',
    executionPlacement: 'machine', placements: [], originalExecution: { daemonIngressSurfaces: ['ui', 'cli'] }, surfaces,
    bindings: { mcpToolName: 'machines_reachability_inspect', rpcMethod: RPC_METHODS.MACHINES_REACHABILITY_INSPECT },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'reachability', 'inspect'], visibility: 'canonical' }] },
    inputSchema: MachineReachabilityInspectInputV1Schema, outputSchema: MachineReachabilityInspectResultV1Schema,
    inputHints: { fields: [...fields, { path: 'change', title: 'Proposed change', widget: 'json', required: false }] },
  },
  { id: 'machines.reachability.configure', title: 'Configure Machine reachability',
    description: 'Apply the exact reviewed reachability change on this Machine.',
    approval: { result: 'required' }, approvalScope: 'machine', safety: 'danger', sideEffectClass: 'danger',
    approvalPolicy: { uiConfirmation: 'policy' }, projectObservationInput: projectConfigureObservationInput,
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
    executionPlacement: 'machine', placements: [], originalExecution: { daemonIngressSurfaces: ['ui', 'cli'] }, surfaces,
    bindings: { mcpToolName: 'machines_reachability_configure', rpcMethod: RPC_METHODS.MACHINES_REACHABILITY_CONFIGURE },
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'reachability', 'configure'], visibility: 'canonical' }] },
    inputSchema: MachineReachabilityConfigureInputV1Schema, outputSchema: MachineReachabilityConfigureResultV1Schema,
    inputHints: { fields: [...fields,
      { path: 'change', title: 'Reviewed change', widget: 'json', required: true },
      { path: 'reviewedPlanDigest', title: 'Reviewed plan digest', widget: 'text', required: true },
      { path: 'reviewedPlanBasis', title: 'Reviewed reachability plan', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
