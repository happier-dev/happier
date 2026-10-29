import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/** One person label across hosts. An Account identity is never a display name. */
export function resolveAccountDisplayLabelV1(profile: Readonly<{ name?: string | null; username?: string | null }>): string | null {
  return profile.name?.trim() || profile.username?.trim() || null;
}

export type AccountActorLabelClassificationV1 =
  | Readonly<{ kind: 'self' }>
  | Readonly<{ kind: 'former' }>
  | Readonly<{ kind: 'profile'; label: string; source: 'name' | 'username' }>
  | Readonly<{ kind: 'unnamed' }>;

/** Pure relationship/profile classification; each host localizes only the resulting label kind. */
export function classifyAccountActorLabelV1(
  actor: Readonly<{ accessibility?: 'current' | 'former'; profile: Readonly<{
    name?: string | null; firstName?: string | null; lastName?: string | null; username?: string | null;
  }> | null }>,
  isSelf: boolean,
): AccountActorLabelClassificationV1 {
  if (actor.accessibility === 'former' || (actor.accessibility === undefined && actor.profile === null)) return { kind: 'former' };
  if (isSelf) return { kind: 'self' };
  const name = actor.profile?.name?.trim()
    || [actor.profile?.firstName?.trim(), actor.profile?.lastName?.trim()].filter(Boolean).join(' ')
    || null;
  if (name) return { kind: 'profile', label: name, source: 'name' };
  const username = actor.profile?.username?.trim();
  return username ? { kind: 'profile', label: username, source: 'username' } : { kind: 'unnamed' };
}

/** Decode released first/last presentation only when the canonical field is absent. */
export function readAccountNameFromLegacyProfileV1(profile: Readonly<{ name?: string | null; firstName?: string | null; lastName?: string | null }>): string | null {
  if (profile.name !== undefined) return profile.name?.trim() || null;
  return [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ') || null;
}

/** Preserve an unsplit chosen name for released clients that compose first/last. */
export function projectAccountNameToLegacyFieldsV1(name: string | null): Readonly<{ firstName: string | null; lastName: null }> {
  return { firstName: name?.trim() || null, lastName: null };
}

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
export const AccountDisplayProfileV1BaseSchema = lazyZodSchema(() => z.strictObject({
  name: z.optional(z.nullable(z.string())),
  firstName: z.nullable(z.string()),
  lastName: z.nullable(z.string()),
  username: z.nullable(z.string()),
  avatarUrl: z.nullable(z.string()),
}));

export const AccountDisplayProfileV1Schema = lazyZodSchema(() => z.pipe(AccountDisplayProfileV1BaseSchema, z.transform(profile => ({ ...profile, name: readAccountNameFromLegacyProfileV1(profile) }))));

export type AccountDisplayProfileV1 = z.infer<typeof AccountDisplayProfileV1Schema>;

export function parseAccountDisplayProfileV1(value: unknown): AccountDisplayProfileV1 | null {
  const parsed = AccountDisplayProfileV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
