import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/**
 * Leaf owner of the external identity tag shape. It imports no contract module,
 * so Usage ingest and the Session control contract can both read it without an
 * initialization cycle.
 */
export const SessionExternalIdentityTagV1Schema = lazyZodSchema(() =>
  z.string().check(z.regex(/^direct:v1:[0-9a-f]{64}$/)),
);
export type SessionExternalIdentityTagV1 = z.infer<
  typeof SessionExternalIdentityTagV1Schema
>;
