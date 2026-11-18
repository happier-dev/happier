import { MACHINE_POOL_ACTION_IDS_V1 } from './actionIdsV1.js';
export { MACHINE_POOL_ACTION_IDS_V1 } from './actionIdsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import type { ActionExecutorContext, ActionExecutorDeps } from '../../actions/executor/types.js';
import { createActionExecuteFailureError } from '../../actions/actionExecutionResult.js';
import type { PrivateLabelRecipientCensusOwnerV1 } from '../../crypto/privateLabelRecipientCensusV1.js';
import type { PrivateLabelStoredV1 } from '../../crypto/privateLabelV1.js';
import {
  MachinePoolCreateActionInputV1Schema,
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
  MachinePoolUpdateActionInputV1Schema,
  MachinePoolUpdateInputV1Schema,
  MachinePoolViewV1Schema,
  type MachinePoolAudienceV1,
  type MachinePoolCreateActionInputV1,
  type MachinePoolUpdateActionInputV1,
} from './v1.js';

export type MachinePoolActionIdV1 = typeof MACHINE_POOL_ACTION_IDS_V1[number];

export const MachinePoolActionIdV1Schema = lazyZodSchema(() => z.enum(MACHINE_POOL_ACTION_IDS_V1));

/** Authored Action intent; create and update may carry plain label text for the Account host to seal. */
export const MachinePoolActionInputSchemasV1 = {
  'machines.pools.list': MachinePoolListInputV1Schema,
  'machines.pools.get': MachinePoolGetInputV1Schema,
  'machines.pools.create': MachinePoolCreateActionInputV1Schema,
  'machines.pools.update': MachinePoolUpdateActionInputV1Schema,
  'machines.pools.delete': MachinePoolDeleteInputV1Schema,
  'machines.pools.resolve': MachinePoolResolveInputV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodMiniType>;

/** Strict Home HTTP bodies: no Pool label plaintext crosses this boundary. */
export const MachinePoolWireInputSchemasV1 = {
  ...MachinePoolActionInputSchemasV1,
  'machines.pools.create': MachinePoolCreateInputV1Schema,
  'machines.pools.update': MachinePoolUpdateInputV1Schema,
} as const satisfies Record<MachinePoolActionIdV1, z.ZodMiniType>;

export type MachinePoolWireInputV1<TActionId extends MachinePoolActionIdV1 = MachinePoolActionIdV1> =
  z.infer<typeof MachinePoolWireInputSchemasV1[TActionId]>;

/**
 * Seals authored Pool labels through the captured Account host before the Home write. The owner is
 * the Pool audience: a personal Pool is the runtime Account's, a Team Pool its Team's. An update that
 * omits its audience reads the retained one and pins it on the write, so labels name its readers.
 */
export async function prepareMachinePoolWriteActionInputV1(
  params: Readonly<{
    actionId: 'machines.pools.create' | 'machines.pools.update';
    input: MachinePoolCreateActionInputV1 | MachinePoolUpdateActionInputV1;
    prepare: ActionExecutorDeps['privateLabelPrepare'];
    context: ActionExecutorContext;
    readRetainedAudience: (poolId: string) => Promise<MachinePoolAudienceV1>;
  }>,
): Promise<MachinePoolWireInputV1<'machines.pools.create' | 'machines.pools.update'>> {
  const { input } = params;
  const authored: { field: 'name' | 'description'; value: string }[] = [];
  const wire: Record<string, unknown> = { ...input };
  if (typeof input.name === 'string') authored.push({ field: 'name', value: input.name.trim() });
  if (typeof input.description === 'string') {
    const description = input.description.trim();
    if (description) authored.push({ field: 'description', value: description });
    else wire.description = null;
  }
  if (authored.length > 0) {
    const accountId = params.context.runtimeAccountId?.trim();
    if (!params.prepare || !accountId) {
      throw createActionExecuteFailureError({ ok: false, errorCode: 'client_required', error: 'Pool label preparation requires the Account client' });
    }
    const audience = input.audience ?? (params.actionId === 'machines.pools.update' ? await params.readRetainedAudience(input.poolId) : undefined);
    if (audience !== undefined) wire.audience = audience;
    const owner: PrivateLabelRecipientCensusOwnerV1 = audience?.kind === 'team'
      ? { kind: 'team', teamId: audience.teamId } : { kind: 'account', accountId };
    const sealed: readonly PrivateLabelStoredV1[] = await params.prepare({ actionId: params.actionId, owner,
      labels: authored.map(label => ({ binding: { entity: 'machine_pool', field: label.field, id: input.poolId }, value: label.value })),
      ...(params.context.signal ? { signal: params.context.signal } : {}),
    }, params.context);
    authored.forEach((label, index) => { wire[label.field] = sealed[index]; });
  }
  return MachinePoolWireInputSchemasV1[params.actionId].parse(wire);
}

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
