import { z } from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';

/** The observation subject is independent of the Machine running its checks. */
export const HealthCheckSubjectV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('environment'), environmentId: id }),
  z.strictObject({ kind: z.literal('machineService'), machineId: id, serviceId: id }),
]));
export type HealthCheckSubjectV1 = z.infer<typeof HealthCheckSubjectV1Schema>;
export const HealthCheckSubjectV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(HealthCheckSubjectV1Schema));
