import { z } from '../../../zodRuntimePolicy.js';

export const LocalServiceDnsLabelV1Schema = z
  .string().check(z.trim(), z.minLength(1), z.maxLength(63), z.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/));
export type LocalServiceDnsLabelV1 = z.infer<typeof LocalServiceDnsLabelV1Schema>;
