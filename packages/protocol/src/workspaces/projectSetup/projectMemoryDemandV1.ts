import * as z from 'zod/mini';

export const ProjectMemoryDemandV1Schema = z.strictObject({
  bytes: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  basis: z.union([
    z.strictObject({ kind: z.literal('declared') }),
    z.strictObject({
      kind: z.literal('measured'),
      operation: z.optional(z.strictObject({
        serverId: z.string().check(z.minLength(1)),
        machineId: z.string().check(z.minLength(1)),
        operationId: z.string().check(z.minLength(1)),
      })),
    }),
  ]),
});
export type ProjectMemoryDemandV1 = z.infer<typeof ProjectMemoryDemandV1Schema>;

/** Effective reviewed demand: none is unknown, and a smaller declaration cannot lower another. */
export function resolveProjectMemoryDemandV1(...demands: readonly (ProjectMemoryDemandV1 | undefined)[]): ProjectMemoryDemandV1 | undefined {
  return demands.reduce<ProjectMemoryDemandV1 | undefined>((largest, demand) =>
    demand && (!largest || demand.bytes > largest.bytes) ? demand : largest, undefined);
}
