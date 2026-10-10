import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The neutral, safe-to-disclose presentation fields of one Home Account.
 *
 * This is deliberately smaller than the social `UserProfile`: it carries no
 * Account identity, email, Home/Team role, relationship state, bio, badge,
 * provider identity, or cryptographic key. Consumers that need an identity
 * carry it beside this profile in their own authorized projection.
 *
 * The schema is strict because identity presentation is security-sensitive: an
 * unknown field is a disclosure bug, not an additive extension.
 */
export const AccountDisplayProfileV1Schema = lazyZodSchema(() => z.object({
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  username: z.string().nullable(),
  avatarUrl: z.string().nullable(),
}).strict());

export type AccountDisplayProfileV1 = z.infer<typeof AccountDisplayProfileV1Schema>;

export function parseAccountDisplayProfileV1(value: unknown): AccountDisplayProfileV1 | null {
  const parsed = AccountDisplayProfileV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
