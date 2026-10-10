import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import {
  MachinePoolCreateInputV1Schema,
  MachinePoolDeleteInputV1Schema,
  MachinePoolDeleteOutputV1Schema,
  MachinePoolGetInputV1Schema,
  MachinePoolListInputV1Schema,
  MachinePoolListOutputV1Schema,
  MachinePoolResolveInputV1Schema,
  MachinePoolResolveResultV1Schema,
  MachinePoolUpdateInputV1Schema,
  MachinePoolViewV1Schema,
} from './v1.js';

/**
 * Six genuine user intents for personal Machine Pools, carried by one Action family so hosts wire a
 * single `machinePoolAction` dependency instead of six.
 */
export const MACHINE_POOL_ACTION_IDS_V1 = [
  'machines.pools.list',
  'machines.pools.get',
  'machines.pools.create',
  'machines.pools.update',
  'machines.pools.delete',
  'machines.pools.resolve',
] as const;

export type MachinePoolActionIdV1 = typeof MACHINE_POOL_ACTION_IDS_V1[number];

export const MachinePoolActionIdV1Schema = lazyZodSchema(() => z.enum(MACHINE_POOL_ACTION_IDS_V1));

export const MachinePoolActionInputSchemasV1 = {
  'machines.pools.list': MachinePoolListInputV1Schema,
  'machines.pools.get': MachinePoolGetInputV1Schema,
  'machines.pools.create': MachinePoolCreateInputV1Schema,
  'machines.pools.update': MachinePoolUpdateInputV1Schema,
  'machines.pools.delete': MachinePoolDeleteInputV1Schema,
  'machines.pools.resolve': MachinePoolResolveInputV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodTypeAny>;

export const MachinePoolActionOutputSchemasV1 = {
  'machines.pools.list': MachinePoolListOutputV1Schema,
  'machines.pools.get': MachinePoolViewV1Schema,
  'machines.pools.create': MachinePoolViewV1Schema,
  'machines.pools.update': MachinePoolViewV1Schema,
  'machines.pools.delete': MachinePoolDeleteOutputV1Schema,
  'machines.pools.resolve': MachinePoolResolveResultV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodTypeAny>;

export type MachinePoolActionInputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolActionInputSchemasV1[TActionId]>;

export type MachinePoolActionOutputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolActionOutputSchemasV1[TActionId]>;

/** The canonical POST path for one pool verb, used by the explicit domain route registrar. */
export function machinePoolActionEndpointPathV1(actionId: MachinePoolActionIdV1): string {
  return `/v1/machines/pools/${actionId.slice('machines.pools.'.length)}`;
}
