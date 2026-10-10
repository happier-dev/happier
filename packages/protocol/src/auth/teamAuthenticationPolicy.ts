import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { TeamIdentityConnectionIdSchema } from '../teams/identity/ids.js';
import { AuthEntryMethodIdV1Schema } from './methodId.js';
import { normalizeAuthMethodId } from './providers.js';

export const TeamAcceptedAuthenticationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('home_method'), methodId: AuthEntryMethodIdV1Schema }).strict(),
  z.object({ kind: z.literal('team_connection'), connectionId: TeamIdentityConnectionIdSchema }).strict(),
]));
export type TeamAcceptedAuthenticationV1 = z.infer<typeof TeamAcceptedAuthenticationV1Schema>;

export const TeamRestrictedAuthenticationPolicyV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  mode: z.literal('restricted'),
  accepted: z.array(TeamAcceptedAuthenticationV1Schema).min(1).superRefine((accepted, context) => {
    const seen = new Set<string>();
    for (const reference of accepted) {
      // Provider method IDs are a case-insensitive namespace (the catalog
      // normalizes to lowercase before collision checks and availability).
      // Deduplicate by that canonical identity so `GitHub` and `github`
      // cannot coexist as distinct accepted entries. Connection IDs are
      // exact opaque server-generated identities and stay case-sensitive.
      const key = reference.kind === 'home_method'
        ? `home_method:${normalizeAuthMethodId(reference.methodId)}`
        : `team_connection:${reference.connectionId}`;
      if (seen.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted authentication references must be unique' });
      }
      seen.add(key);
    }
  }),
}).strict());
export type TeamRestrictedAuthenticationPolicyV1 = z.infer<typeof TeamRestrictedAuthenticationPolicyV1Schema>;

export const TeamAuthenticationPolicyV1Schema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({ v: z.literal(1), mode: z.literal('inherit') }).strict(),
  TeamRestrictedAuthenticationPolicyV1Schema,
]));
export type TeamAuthenticationPolicyV1 = z.infer<typeof TeamAuthenticationPolicyV1Schema>;

/** The persistence owner stores inherit as null and restricted references in stable tagged-id order. */
export function normalizeTeamAuthenticationPolicyV1(
  input: TeamAuthenticationPolicyV1,
): TeamRestrictedAuthenticationPolicyV1 | null {
  const policy = TeamAuthenticationPolicyV1Schema.parse(input);
  if (policy.mode === 'inherit') return null;
  return {
    ...policy,
    accepted: [...policy.accepted].sort((left, right) => {
      const leftKey = left.kind === 'home_method'
        ? `home_method:${normalizeAuthMethodId(left.methodId)}`
        : `team_connection:${left.connectionId}`;
      const rightKey = right.kind === 'home_method'
        ? `home_method:${normalizeAuthMethodId(right.methodId)}`
        : `team_connection:${right.connectionId}`;
      return leftKey.localeCompare(rightKey);
    }),
  };
}
