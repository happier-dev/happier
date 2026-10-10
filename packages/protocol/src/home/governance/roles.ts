import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The Home-governance role of one Account. This is the sole Home authority
 * fact: Team role lives on the Team membership and neither implies the other.
 * Roles are a fixed, scope-specific enum — there is no role inheritance,
 * polymorphic role table, or role authority carried in a bearer token.
 */
export const HomeRoleV1Schema = lazyZodSchema(() => z.enum(['owner', 'admin', 'member']));
export type HomeRoleV1 = z.infer<typeof HomeRoleV1Schema>;

/**
 * The Account lifecycle fact. `suspended` is the reversible Home-administration
 * hold shown as **Disabled**; `disabled` is the terminal state shown as
 * **Retired** and is never re-enabled through ordinary Home administration.
 */
export const AccountStatusV1Schema = lazyZodSchema(() => z.enum(['active', 'suspended', 'disabled']));
export type AccountStatusV1 = z.infer<typeof AccountStatusV1Schema>;

/**
 * The single predicate for "may this Account exercise Home authority, hold a
 * required ownership, or be assigned one". Callers must not spell this as
 * `status !== 'disabled'`: a suspended Account is equally unable to authorize.
 */
export function isActiveHomeAccountStatus(status: AccountStatusV1): boolean {
  return status === 'active';
}
