import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 = 200;
export const ActionOperationProgressPhaseV1Schema = lazyZodSchema(() => z.string().check(
  z.trim(), z.minLength(1), z.maxLength(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1),
));
