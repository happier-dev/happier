import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const AuthProviderIdSchema = lazyZodSchema(() => z.string().min(1));
export type AuthProviderId = z.infer<typeof AuthProviderIdSchema>;

/**
 * The canonical identity of an authentication method/provider id.
 *
 * Provider ids are a case-insensitive namespace and the stored bytes are
 * caller-supplied (an API/SDK `teams.policy.set` caller may store `" GitHub "`),
 * so every place that compares, dedupes, joins or looks one up must agree on
 * one normal form. This is that form. It never rewrites stored bytes — the
 * exact configured reference stays exactly as the Team wrote it.
 */
export function normalizeAuthMethodId(value: string): string {
  return value.trim().toLowerCase();
}
