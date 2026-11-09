import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { MachineAdministrationTargetV1Schema } from '../account/settings/machineAdministrationSelectionsV1.js';
import { NpmRegistryProfileIdV1Schema, NpmRegistryProfileInputV1Schema,
  NpmRegistryProfileRevisionV1Schema, NpmRegistryProfileMutationIdV1Schema,
  NpmRegistryProfileLoginMethodV1Schema,
  DaemonNpmRegistryProfileMutationResponseV1Schema, DaemonNpmRegistryProfilesGetResponseV1Schema } from '../rpc/npmRegistryProfiles.js';

export { NPM_REGISTRY_PROFILE_ACTION_IDS_V1, NpmRegistryProfileActionIdV1Schema,
  type NpmRegistryProfileActionIdV1 } from './npmRegistryProfileActionIds.js';
const mutationShape = {
  target: MachineAdministrationTargetV1Schema,
  expectedRevision: NpmRegistryProfileRevisionV1Schema,
  mutationId: NpmRegistryProfileMutationIdV1Schema,
  profileId: NpmRegistryProfileIdV1Schema,
};
const mutation = lazyZodSchema(() => z.strictObject(mutationShape));
const profileMutation = lazyZodSchema(() => z.strictObject({ ...mutationShape, profile: NpmRegistryProfileInputV1Schema }));
/** Credentials are acquired by the executing native host after admission, never from Action arguments. */
export const NpmRegistryProfileActionInputSchemasV1 = {
  'plugins.npm_registry_profiles.list': lazyZodSchema(() => z.strictObject({ target: MachineAdministrationTargetV1Schema })),
  'plugins.npm_registry_profiles.add': profileMutation,
  'plugins.npm_registry_profiles.update': profileMutation,
  'plugins.npm_registry_profiles.remove': mutation,
  'plugins.npm_registry_profiles.login': lazyZodSchema(() => z.strictObject({ ...mutationShape, login: z.optional(NpmRegistryProfileLoginMethodV1Schema) })),
  'plugins.npm_registry_profiles.logout': mutation,
  'plugins.npm_registry_profiles.test': mutation,
} as const;
const mutationResult = lazyZodSchema(() => z.union([DaemonNpmRegistryProfileMutationResponseV1Schema,
  z.strictObject({ status: z.literal('outcomeUnknown') })]));
export const NpmRegistryProfileActionOutputSchemasV1 = {
  'plugins.npm_registry_profiles.list': DaemonNpmRegistryProfilesGetResponseV1Schema,
  'plugins.npm_registry_profiles.add': mutationResult,
  'plugins.npm_registry_profiles.update': mutationResult,
  'plugins.npm_registry_profiles.remove': mutationResult,
  'plugins.npm_registry_profiles.login': mutationResult,
  'plugins.npm_registry_profiles.logout': mutationResult,
  'plugins.npm_registry_profiles.test': mutationResult,
} as const;
