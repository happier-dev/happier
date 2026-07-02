import { z } from 'zod';

export const LocalServiceDnsLabelV1Schema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export type LocalServiceDnsLabelV1 = z.infer<typeof LocalServiceDnsLabelV1Schema>;
