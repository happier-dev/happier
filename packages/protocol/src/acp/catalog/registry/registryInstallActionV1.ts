import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { RegistryItemPointerV1Schema } from '../../../registries/registryItemsV1.js';
import { AcpBackendDefinitionV1Schema } from '../settingsV1.js';

export const AgentsAcpBackendsInstallFromRegistryInputV1Schema = lazyZodSchema(() => z.strictObject({
  fromRegistry: RegistryItemPointerV1Schema,
  installOn: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.refine(ids => new Set(ids).size === ids.length, 'An install target may appear only once'))),
}));
export type AgentsAcpBackendsInstallFromRegistryInputV1 = z.infer<typeof AgentsAcpBackendsInstallFromRegistryInputV1Schema>;

export const AgentsAcpBackendsInstallFromRegistryOutputV1Schema = lazyZodSchema(() => z.strictObject({
  definition: AcpBackendDefinitionV1Schema,
  jobs: z.array(z.strictObject({ machineId: z.string().check(z.minLength(1)), jobId: z.string().check(z.minLength(1)) })),
}));
export type AgentsAcpBackendsInstallFromRegistryOutputV1 = z.infer<typeof AgentsAcpBackendsInstallFromRegistryOutputV1Schema>;
