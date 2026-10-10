import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** Home-local identity shared by resource grants; this grants no authority itself. */
export const AccountPrincipalRefV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('account'),
  accountId: z.string().min(1),
}).strict());
export const TeamPrincipalRefV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('team'),
  teamId: z.string().min(1),
}).strict());
export const GroupPrincipalRefV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('group'),
  teamId: z.string().min(1),
  groupId: z.string().min(1),
}).strict());
export const PrincipalRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AccountPrincipalRefV1Schema,
  TeamPrincipalRefV1Schema,
  GroupPrincipalRefV1Schema,
]));
export type PrincipalRefV1 = z.infer<typeof PrincipalRefV1Schema>;
