import { z } from 'zod';

import { AnyClientUpgradeRequiredV1Schema } from '../clientCompatibility/upgradeRequiredV1.js';
import { MachineEncodedWriteBasisV1Schema } from './machineContentKeyTransitionV1.js';

export const MachineUpdateMetadataRequestSchema = z
  .object({
    ...MachineEncodedWriteBasisV1Schema.shape,
    machineId: z.string().min(1).optional(),
    metadata: z.string(),
  })
  .strict();

export type MachineUpdateMetadataRequest = z.infer<
  typeof MachineUpdateMetadataRequestSchema
>;

const MachineUpdateMetadataResultResponseSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('key-mismatch') }).strict(),
  z.object({
    result: z.literal('error'),
    message: z.string().optional(),
  }).strict(),
  z.object({
    result: z.literal('version-mismatch'),
    version: z.number().int().nonnegative(),
    metadata: z.string(),
  }).strict(),
  z.object({
    result: z.literal('success'),
    version: z.number().int().nonnegative(),
    metadata: z.string(),
  }).strict(),
]);

export const MachineUpdateMetadataResponseSchema = z.union([
  MachineUpdateMetadataResultResponseSchema,
  AnyClientUpgradeRequiredV1Schema,
]);

export type MachineUpdateMetadataResponse = z.infer<
  typeof MachineUpdateMetadataResponseSchema
>;

export const MachineUpdateStateRequestSchema = z.object({
  ...MachineEncodedWriteBasisV1Schema.shape,
  machineId: z.string().min(1).optional(),
  daemonState: z.string(),
}).strict();
export type MachineUpdateStateRequest = z.infer<typeof MachineUpdateStateRequestSchema>;

export const MachineUpdateStateResponseSchema = z.union([
  z.discriminatedUnion('result', [
    z.object({ result: z.literal('key-mismatch') }).strict(),
    z.object({ result: z.literal('error'), message: z.string().optional() }).strict(),
    z.object({ result: z.literal('version-mismatch'), version: z.number().int().nonnegative(), daemonState: z.string().nullable() }).strict(),
    z.object({ result: z.literal('success'), version: z.number().int().nonnegative(), daemonState: z.string().nullable() }).strict(),
  ]),
  AnyClientUpgradeRequiredV1Schema,
]);
export type MachineUpdateStateResponse = z.infer<typeof MachineUpdateStateResponseSchema>;
