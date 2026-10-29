import { NPM_REGISTRY_PROFILE_ACTION_IDS_V1 } from './npmRegistryProfileIdsV1.js';
export { NPM_REGISTRY_PROFILE_ACTION_IDS_V1 } from './npmRegistryProfileIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
export type NpmRegistryProfileActionIdV1 = typeof NPM_REGISTRY_PROFILE_ACTION_IDS_V1[number];
export const NpmRegistryProfileActionIdV1Schema = lazyZodSchema(() => z.enum(NPM_REGISTRY_PROFILE_ACTION_IDS_V1));
