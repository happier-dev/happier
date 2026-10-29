import { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from './idsV1.js';
export { EPHEMERAL_RUNNER_ACTION_IDS_V1 } from './idsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
export type EphemeralRunnerActionIdV1 = typeof EPHEMERAL_RUNNER_ACTION_IDS_V1[number];
export const EphemeralRunnerActionIdV1Schema = lazyZodSchema(() => z.enum(EPHEMERAL_RUNNER_ACTION_IDS_V1));
