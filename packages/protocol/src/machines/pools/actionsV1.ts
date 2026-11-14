import { MACHINE_POOL_ACTION_IDS_V1 } from './actionIdsV1.js';
export { MACHINE_POOL_ACTION_IDS_V1 } from './actionIdsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  MachinePoolCreateInputV1Schema,
  MachinePoolDeleteInputV1Schema,
  MachinePoolDeleteOutputV1Schema,
  MachinePoolGetInputV1Schema,
  MachinePoolListInputV1Schema,
  MachinePoolOpenedListOutputV1Schema,
  MachinePoolListOutputV1Schema,
  MachinePoolPrivateViewV1Schema,
  type MachinePoolPrivateViewV1,
  type MachinePoolViewV1,
  MachinePoolResolveInputV1Schema,
  MachinePoolResolveResultV1Schema,
  MachinePoolUpdateInputV1Schema,
  MachinePoolViewV1Schema,
} from './v1.js';

export type MachinePoolActionIdV1 = typeof MACHINE_POOL_ACTION_IDS_V1[number];

export const MachinePoolActionIdV1Schema = lazyZodSchema(() => z.enum(MACHINE_POOL_ACTION_IDS_V1));

export const MachinePoolActionInputSchemasV1 = {
  'machines.pools.list': MachinePoolListInputV1Schema,
  'machines.pools.get': MachinePoolGetInputV1Schema,
  'machines.pools.create': MachinePoolCreateInputV1Schema,
  'machines.pools.update': MachinePoolUpdateInputV1Schema,
  'machines.pools.delete': MachinePoolDeleteInputV1Schema,
  'machines.pools.resolve': MachinePoolResolveInputV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodMiniType>;

export const MachinePoolActionOutputSchemasV1 = {
  'machines.pools.list': MachinePoolOpenedListOutputV1Schema,
  'machines.pools.get': MachinePoolViewV1Schema,
  'machines.pools.create': MachinePoolViewV1Schema,
  'machines.pools.update': MachinePoolViewV1Schema,
  'machines.pools.delete': MachinePoolDeleteOutputV1Schema,
  'machines.pools.resolve': MachinePoolResolveResultV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodMiniType>;

/** HTTP responses remain recipient-scoped until the admitted client host opens them. */
export const MachinePoolWireOutputSchemasV1 = {
  ...MachinePoolActionOutputSchemasV1,
  'machines.pools.list': MachinePoolListOutputV1Schema,
  'machines.pools.get': MachinePoolPrivateViewV1Schema,
  'machines.pools.create': MachinePoolPrivateViewV1Schema,
  'machines.pools.update': MachinePoolPrivateViewV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodMiniType>;

export type MachinePoolWireOutputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolWireOutputSchemasV1[TActionId]>;

/** Each host supplies its existing captured-Account opener; Action consumers see one opened result. */
export async function openMachinePoolActionOutputV1(
  output: MachinePoolWireOutputV1,
  openPool: (view: MachinePoolPrivateViewV1) => MachinePoolViewV1 | null | Promise<MachinePoolViewV1 | null>,
): Promise<MachinePoolActionOutputV1 | null> {
  if ('pools' in output) {
    const pools = await Promise.all(output.pools.map(openPool));
    if (pools.some(pool => pool === null)) return null;
    return { ...output, pools: pools.filter((pool): pool is MachinePoolViewV1 => pool !== null) };
  }
  if ('pool' in output) return await openPool(output);
  return output;
}

export type MachinePoolActionInputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolActionInputSchemasV1[TActionId]>;

export type MachinePoolActionOutputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolActionOutputSchemasV1[TActionId]>;

/** The canonical POST path for one pool verb, used by the explicit domain route registrar. */
export function machinePoolActionEndpointPathV1(actionId: MachinePoolActionIdV1): string {
  return `/v1/machines/pools/${actionId.slice('machines.pools.'.length)}`;
}
