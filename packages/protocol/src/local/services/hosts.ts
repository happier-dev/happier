import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import {
  isLiteralLoopbackHostname,
  normalizeHostnameForLoopbackCheck,
} from '../../server/urls/loopbackHostname.js';

export const LocalServiceLoopbackHostV1Schema = lazyZodSchema(() => z
  .string()
  .trim()
  .min(1)
  .transform(normalizeHostnameForLoopbackCheck)
  .refine(isLiteralLoopbackHostname, {
    message: 'Local service host must be loopback.',
  }));
export type LocalServiceLoopbackHostV1 = z.infer<typeof LocalServiceLoopbackHostV1Schema>;
