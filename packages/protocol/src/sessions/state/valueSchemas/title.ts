import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

export const SessionStateTitleValueSchema = lazyZodSchema(() => z.string());
