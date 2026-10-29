import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getMachineMetadataFieldV1, mutateMachineMetadataFieldV1, readMachineMetadataFieldV1,
  type MachineMetadataFieldDefinitionV1, type MachineMetadataFieldPortV1 } from './machineMetadataFieldV1.js';

/** Adopted native intent only. Native health, generations and log bytes never persist here. */
export const MachineServiceWatchV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), watchId: z.string().check(z.minLength(1)), name: z.string().check(z.trim(), z.minLength(1)),
  adapter: asProtocolZod(PluginContributionIdentityV1Schema),
  nativeResourceId: z.string().check(z.minLength(1), z.regex(/^[^\0]*$/u)),
  lifecyclePurpose: z.enum(['development', 'deployment', 'infrastructure']),
}));
export type MachineServiceWatchV1 = z.infer<typeof MachineServiceWatchV1Schema>;

/** The native adapter supplies the canonical opaque native id; the host never guesses it. */
export function machineServiceNativeIdentityKeyV1(instance: Pick<MachineServiceWatchV1, 'adapter' | 'nativeResourceId'>): string {
  return JSON.stringify([instance.adapter.pluginId, instance.adapter.localId, instance.nativeResourceId]);
}

export const MachineServiceWatchesV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), watches: z.array(MachineServiceWatchV1Schema),
}).check(z.superRefine((value, ctx) => {
  const watchIds = new Set<string>();
  const instances = new Set<string>();
  for (const [index, watch] of value.watches.entries()) {
    const instance = machineServiceNativeIdentityKeyV1(watch);
    if (watchIds.has(watch.watchId) || instances.has(instance)) {
      ctx.addIssue({ code: 'custom', path: ['watches', index], message: 'A watch id and native instance each have one declaration per Machine.' });
    }
    watchIds.add(watch.watchId);
    instances.add(instance);
  }
})));
export type MachineServiceWatchesV1 = z.infer<typeof MachineServiceWatchesV1Schema>;

export const MachineServiceWatchesFieldV1: MachineMetadataFieldDefinitionV1<MachineServiceWatchesV1> = {
  field: 'serviceWatchesV1', storedSchema: MachineServiceWatchesV1Schema,
  defaultValue: () => ({ v: 1, watches: [] }), equal: sameStrictJsonValue,
};
export function readMachineServiceWatchesV1(metadata: unknown) {
  return readMachineMetadataFieldV1(metadata, MachineServiceWatchesFieldV1);
}
export function getMachineServiceWatchesV1(port: MachineMetadataFieldPortV1) {
  return getMachineMetadataFieldV1(port, MachineServiceWatchesFieldV1);
}
/** Keep the incumbent field-CAS rebase and lost-ACK semantics; there is no watch writer beside it. */
export async function mutateMachineServiceWatchesV1(input: Readonly<{
  expectedMetadataVersion: number; expectedWatches: MachineServiceWatchesV1; watches: MachineServiceWatchesV1;
}>, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>) {
  const previous = MachineServiceWatchesV1Schema.safeParse(input.expectedWatches);
  const next = MachineServiceWatchesV1Schema.safeParse(input.watches);
  if (!previous.success || !next.success) return { status: 'invalid' as const };
  return mutateMachineMetadataFieldV1({ expectedMetadataVersion: input.expectedMetadataVersion,
    expectedPolicy: previous.data, policy: next.data, comparison: 'field' }, port, MachineServiceWatchesFieldV1, options);
}
