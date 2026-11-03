import { z } from 'zod/mini';

import { AnyClientUpgradeRequiredV1Schema } from '../clientCompatibility/upgradeRequiredV1.js';
import { MachineEncodedWriteBasisV1Schema } from './machineContentKeyTransitionV1.js';

export const MachineUpdateMetadataRequestSchema = z.strictObject({
    ...MachineEncodedWriteBasisV1Schema.shape,
    machineId: z.optional(z.string().check(z.minLength(1))),
    metadata: z.string(),
  });

export type MachineUpdateMetadataRequest = z.infer<
  typeof MachineUpdateMetadataRequestSchema
>;

const MachineUpdateMetadataResultResponseSchema = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('key-mismatch') }),
  z.strictObject({
    result: z.literal('error'),
    message: z.optional(z.string()),
  }),
  z.strictObject({
    result: z.literal('version-mismatch'),
    version: z.number().check(z.int(), z.nonnegative()),
    metadata: z.string(),
  }),
  z.strictObject({
    result: z.literal('success'),
    version: z.number().check(z.int(), z.nonnegative()),
    metadata: z.string(),
  }),
]);

export const MachineUpdateMetadataResponseSchema = z.union([
  MachineUpdateMetadataResultResponseSchema,
  AnyClientUpgradeRequiredV1Schema,
]);

export type MachineUpdateMetadataResponse = z.infer<
  typeof MachineUpdateMetadataResponseSchema
>;

export const MachineUpdateStateRequestSchema = z.strictObject({
  ...MachineEncodedWriteBasisV1Schema.shape,
  machineId: z.optional(z.string().check(z.minLength(1))),
  daemonState: z.string(),
  /** Non-persisted wake hint, never evidence of idle or effect admission. */
  managedActivityChanged: z.optional(z.literal(true)),
});
export type MachineUpdateStateRequest = z.infer<typeof MachineUpdateStateRequestSchema>;

export const MachineUpdateStateResponseSchema = z.union([
  z.discriminatedUnion('result', [
    z.strictObject({ result: z.literal('key-mismatch') }),
    z.strictObject({ result: z.literal('error'), message: z.optional(z.string()) }),
    z.strictObject({ result: z.literal('version-mismatch'), version: z.number().check(z.int(), z.nonnegative()), daemonState: z.nullable(z.string()) }),
    z.strictObject({ result: z.literal('success'), version: z.number().check(z.int(), z.nonnegative()), daemonState: z.nullable(z.string()) }),
  ]),
  AnyClientUpgradeRequiredV1Schema,
]);
export type MachineUpdateStateResponse = z.infer<typeof MachineUpdateStateResponseSchema>;
