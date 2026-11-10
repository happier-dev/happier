import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import {
  isLiteralLoopbackHostname,
  normalizeHostnameForLoopbackCheck,
} from '../../server/urls/loopbackHostname.js';

export const LocalServiceLoopbackHostV1Schema = lazyZodSchema(() => z.pipe(z
  .string().check(z.trim(), z.minLength(1)), z.transform(normalizeHostnameForLoopbackCheck)).check(z.refine(isLiteralLoopbackHostname, {
    message: 'Local service host must be loopback.',
  })));
export type LocalServiceLoopbackHostV1 = z.infer<typeof LocalServiceLoopbackHostV1Schema>;
