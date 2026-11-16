import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSurfaceSchema } from './metadata.js';
import type { ActionSettingsOverride, ActionsSettingsV1 } from './actionSettings.js';

import { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
export { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
const ApprovalProfileSurfaceListV1Schema = lazyZodSchema(() => z.array(z.keyof(ActionSurfaceSchema)));
/**
 * The Account Approval-settings policy fields of one Action. Placements and tool exposure
 * stay Account UI, so a stored row keeps only these keys.
 */
export const ApprovalProfileActionRowV1Schema = lazyZodSchema(() => z.object({
  enabled: z.optional(z.boolean()),
  disabledSurfaces: z.optional(ApprovalProfileSurfaceListV1Schema),
  approvalRequiredSurfaces: z.optional(ApprovalProfileSurfaceListV1Schema),
}));
/**
 * A saved Account preference: a named per-Action overlay of the Account Approval settings,
 * never authority or a copy carried by a Session. Only Actions the person changed are stored.
 * Strict, so a row in any other shape (such as a pre-overlay `defaultMode` policy) is unusable
 * rather than read as an empty overlay that silently follows the Account settings.
 */
export const ApprovalProfileV1Schema = lazyZodSchema(() => z.strictObject({
  id: ApprovalProfileIdV1Schema,
  name: z.string().check(z.trim(), z.minLength(1)),
  actions: z.optional(z.record(z.string(), ApprovalProfileActionRowV1Schema)),
  approvalWaivedSurfaces: z.optional(z.record(z.string(), ApprovalProfileSurfaceListV1Schema)),
}));
export type ApprovalProfileV1 = z.infer<typeof ApprovalProfileV1Schema>;
export type ApprovalProfileActionRowV1 = z.infer<typeof ApprovalProfileActionRowV1Schema>;

export function resolveInheritedApprovalProfileIdV1(
  requestedId: string | null | undefined,
  inheritedId: string | null | undefined,
): string | null {
  return requestedId === undefined ? inheritedId ?? null : requestedId;
}

export const ApprovalProfileResolutionV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['available', 'missing']),
  requestedId: ApprovalProfileIdV1Schema,
}));
export type ApprovalProfileResolutionV1 = Readonly<z.infer<typeof ApprovalProfileResolutionV1Schema>>;

export function listApprovalProfilesV1(settings: Readonly<{ approvalProfiles?: readonly ApprovalProfileV1[] }>): readonly ApprovalProfileV1[] {
  return settings.approvalProfiles ?? [];
}

/** Malformed stored rows are unavailable, so their references settle visibly as missing. */
export function normalizeStoredApprovalProfilesV1(raw: unknown): ApprovalProfileV1[] {
  if (!Array.isArray(raw)) return [];
  const profiles = new Map<string, ApprovalProfileV1>();
  for (const row of raw) {
    const parsed = ApprovalProfileV1Schema.safeParse(row);
    if (parsed.success) profiles.set(parsed.data.id, parsed.data);
  }
  return [...profiles.values()];
}

/** Selection only. A missing reference settles at the Account settings, with a visible status. */
export function readApprovalProfileV1(settings: Readonly<{ approvalProfiles?: readonly ApprovalProfileV1[] }> | null | undefined,
  requestedId: string): Readonly<{ profile: ApprovalProfileV1 | null; resolution: ApprovalProfileResolutionV1 }> {
  const profile = settings?.approvalProfiles?.find(row => row.id === requestedId) ?? null;
  return { profile, resolution: { status: profile ? 'available' : 'missing', requestedId } };
}

/**
 * The one Session → profile reference rule, read at each admission: the Session's own choice,
 * else the person's default for the Session's Machine, else none (Account settings).
 * A Session without its own choice stores null or nothing.
 */
export function resolveSessionApprovalProfileReferenceV1(
  metadata: Readonly<{ approvalProfileId?: unknown; machineId?: unknown }>,
  settings: Readonly<{ machineApprovalProfiles?: Readonly<Record<string, string>> }> | null | undefined,
): string | null {
  const own = ApprovalProfileIdV1Schema.safeParse(metadata.approvalProfileId);
  if (own.success) return own.data;
  return typeof metadata.machineId === 'string' ? settings?.machineApprovalProfiles?.[metadata.machineId] ?? null : null;
}

const EMPTY_ACTION_ROW: ActionSettingsOverride = Object.freeze({ enabledPlacements: [], disabledPlacements: [],
  disabledSurfaces: [], approvalRequiredSurfaces: [], toolExposureModes: {} });

/**
 * For each Action the profile names, its row and waiver list replace the Account's policy for
 * that Action; Account placements, tool exposure and every other Action stay as they are.
 * The routing owner then evaluates the merged settings with its usual floors.
 */
export function applyApprovalProfileOverlayV1(settings: ActionsSettingsV1, profile: ApprovalProfileV1): ActionsSettingsV1 {
  const ids = new Set([...Object.keys(profile.actions ?? {}), ...Object.keys(profile.approvalWaivedSurfaces ?? {})]);
  if (ids.size === 0) return settings;
  const actions = { ...settings.actions };
  const waivers = { ...settings.approvalWaivedSurfaces };
  for (const id of ids) {
    const row = profile.actions?.[id];
    const { enabled: _accountEnabled, ...base } = settings.actions[id] ?? EMPTY_ACTION_ROW;
    actions[id] = { ...base, ...(row?.enabled === undefined ? {} : { enabled: row.enabled }),
      disabledSurfaces: row?.disabledSurfaces ?? [], approvalRequiredSurfaces: row?.approvalRequiredSurfaces ?? [] };
    const waived = profile.approvalWaivedSurfaces?.[id];
    if (waived?.length) waivers[id] = waived;
    else delete waivers[id];
  }
  const { approvalWaivedSurfaces: _accountWaivers, ...rest } = settings;
  return { ...rest, actions, ...(Object.keys(waivers).length > 0 ? { approvalWaivedSurfaces: waivers } : {}) };
}

/** The settings an invocation with this profile reference is decided on, and the visible resolution. */
export function resolveProfiledActionsSettingsV1(settings: ActionsSettingsV1, approvalProfileId: string | null | undefined):
  Readonly<{ settings: ActionsSettingsV1; profile?: ApprovalProfileResolutionV1 }> {
  if (!approvalProfileId) return { settings };
  const selected = readApprovalProfileV1(settings, approvalProfileId);
  return { settings: selected.profile ? applyApprovalProfileOverlayV1(settings, selected.profile) : settings,
    profile: selected.resolution };
}

/** A Session's effective Action policy: Account settings with that Session's profile applied. */
export function applySessionApprovalProfileV1(settings: ActionsSettingsV1,
  metadata: Readonly<{ approvalProfileId?: unknown; machineId?: unknown }> | null | undefined): ActionsSettingsV1 {
  return resolveProfiledActionsSettingsV1(settings,
    metadata ? resolveSessionApprovalProfileReferenceV1(metadata, settings) : null).settings;
}
