import { z } from 'zod';

import { AnyClientUpgradeRequiredV1Schema } from '../clientCompatibility/upgradeRequiredV1.js';

export const MachineUpdateMetadataRequestSchema = z
  .object({
    machineId: z.string().min(1).optional(),
    metadata: z.string(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type MachineUpdateMetadataRequest = z.infer<
  typeof MachineUpdateMetadataRequestSchema
>;

const MachineUpdateMetadataResultResponseSchema = z.discriminatedUnion('result', [
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
