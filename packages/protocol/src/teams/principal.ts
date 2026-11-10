import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Home-local identity shared by resource grants; this grants no authority itself. */
export const AccountPrincipalRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
  accountId: z.string().check(z.minLength(1)),
}));
export const TeamPrincipalRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('team'),
  teamId: z.string().check(z.minLength(1)),
}));
export const GroupPrincipalRefV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('group'),
  teamId: z.string().check(z.minLength(1)),
  groupId: z.string().check(z.minLength(1)),
}));
export const PrincipalRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AccountPrincipalRefV1Schema,
  TeamPrincipalRefV1Schema,
  GroupPrincipalRefV1Schema,
]));
export type PrincipalRefV1 = z.infer<typeof PrincipalRefV1Schema>;
