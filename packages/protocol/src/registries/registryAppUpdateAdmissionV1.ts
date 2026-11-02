import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from '../deployments/deploymentIdentifiersV1.js';

/** The current Environment owns its template pin; callers select no source or Artifact operands. */
export const RegistryAppUpdateDemandV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: DeploymentIdentifierV1Schema, expectedRevision: DeploymentRevisionV1Schema,
}));
export type RegistryAppUpdateDemandV1 = z.infer<typeof RegistryAppUpdateDemandV1Schema>;
export const RegistryAppUpdateAdmissionV1Schema = lazyZodSchema(() => z.strictObject({
  environments: z.array(RegistryAppUpdateDemandV1Schema),
}));
export type RegistryAppUpdateAdmissionV1 = z.infer<typeof RegistryAppUpdateAdmissionV1Schema>;

/** Closed read-purpose projection, independent of Action-catalog initialization. */
export function projectRegistryAppUpdateAdmissionV1(actionId: string, input: unknown): RegistryAppUpdateAdmissionV1 | undefined {
  const value = readRecord(input);
  return actionId === 'registries.updates.check' && value.kind === 'app'
    ? RegistryAppUpdateAdmissionV1Schema.parse({ environments: value.environments }) : undefined;
}
