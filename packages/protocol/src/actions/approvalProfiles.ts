import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const ApprovalProfileIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export const ApprovalProfileModeV1Schema = lazyZodSchema(() => z.enum(['require', 'ask', 'allow']));
/** A saved Account preference, never authority or a copy carried by a Session. */
export const ApprovalProfileV1Schema = lazyZodSchema(() => z.strictObject({
  id: ApprovalProfileIdV1Schema,
  name: z.string().check(z.trim(), z.minLength(1)),
  defaultMode: ApprovalProfileModeV1Schema,
  actions: z.optional(z.record(z.string(), ApprovalProfileModeV1Schema)),
  categories: z.optional(z.strictObject({
    safe: z.optional(ApprovalProfileModeV1Schema),
    danger: z.optional(ApprovalProfileModeV1Schema),
  })),
}));
export type ApprovalProfileV1 = z.infer<typeof ApprovalProfileV1Schema>;
export type ApprovalProfileModeV1 = z.infer<typeof ApprovalProfileModeV1Schema>;

export function resolveInheritedApprovalProfileIdV1(
  requestedId: string | null | undefined,
  inheritedId: string | null | undefined,
): string | null {
  return requestedId === undefined ? inheritedId ?? null : requestedId;
}

export const BUILTIN_APPROVAL_PROFILES_V1: readonly ApprovalProfileV1[] = Object.freeze([
  { id: 'builtin:read-propose', name: 'Read & propose only', defaultMode: 'require' },
  { id: 'builtin:apply-safe', name: 'Apply safe actions', defaultMode: 'allow', categories: { danger: 'ask' } },
  { id: 'builtin:full-trust', name: 'Full trust', defaultMode: 'allow' },
]);

export const ApprovalProfileResolutionV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ status: z.literal('available'), requestedId: ApprovalProfileIdV1Schema, effectiveId: ApprovalProfileIdV1Schema }),
  z.strictObject({ status: z.literal('missing'), requestedId: ApprovalProfileIdV1Schema, effectiveId: z.literal('builtin:read-propose') }),
]));
export type ApprovalProfileResolutionV1 = Readonly<z.infer<typeof ApprovalProfileResolutionV1Schema>>;

export function listApprovalProfilesV1(settings: Readonly<{ approvalProfiles?: readonly ApprovalProfileV1[] }>): readonly ApprovalProfileV1[] {
  return [...BUILTIN_APPROVAL_PROFILES_V1, ...(settings.approvalProfiles ?? [])];
}

/** Malformed stored rows are unavailable, so references settle at the strict fallback. */
export function normalizeStoredApprovalProfilesV1(raw: unknown): ApprovalProfileV1[] {
  if (!Array.isArray(raw)) return [];
  const profiles = new Map<string, ApprovalProfileV1>();
  for (const row of raw) {
    const parsed = ApprovalProfileV1Schema.safeParse(row);
    if (parsed.success && !parsed.data.id.startsWith('builtin:')) profiles.set(parsed.data.id, parsed.data);
  }
  return [...profiles.values()];
}

/** Selection only: the single routing owner applies the rule to its admitted policy. */
export function readApprovalProfileV1(settings: Readonly<{ approvalProfiles?: readonly ApprovalProfileV1[] }> | null | undefined,
  requestedId: string): Readonly<{ profile: ApprovalProfileV1; resolution: ApprovalProfileResolutionV1 }> {
  const profile = BUILTIN_APPROVAL_PROFILES_V1.find(row => row.id === requestedId)
    ?? settings?.approvalProfiles?.find(row => row.id === requestedId);
  if (profile) return { profile, resolution: { status: 'available', requestedId, effectiveId: profile.id } };
  return { profile: BUILTIN_APPROVAL_PROFILES_V1[0]!,
    resolution: { status: 'missing', requestedId, effectiveId: 'builtin:read-propose' } };
}
