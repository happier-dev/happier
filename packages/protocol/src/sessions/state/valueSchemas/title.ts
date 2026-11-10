import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

export const SessionStateTitleValueSchema = lazyZodSchema(() => z.string());
