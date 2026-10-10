import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/** A server decision projected for presentation; mutation authority is always rechecked. */
export const SessionAccessCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  readTranscript: z.boolean(),
  submitAgentInput: z.boolean(),
  editSessionRecords: z.boolean(),
  approveRuntimePermissions: z.boolean(),
  manageAccess: z.boolean(),
  managePermissionDelegation: z.boolean(),
  managePublicLink: z.boolean(),
  archiveSession: z.boolean(),
  renameSession: z.boolean(),
  assignResponsibility: z.boolean(),
  stopSession: z.boolean(),
  deleteSession: z.boolean(),
}).strict());
export type SessionAccessCapabilitiesV1 = z.infer<typeof SessionAccessCapabilitiesV1Schema>;

export const SessionAccessSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({ kind: z.literal('direct'), shareId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('team'), teamId: z.string().min(1), requiredByTeamPolicy: z.boolean() }).strict(),
  z.object({ kind: z.literal('group'), teamId: z.string().min(1), groupId: z.string().min(1) }).strict(),
]));
export type SessionAccessSourceV1 = z.infer<typeof SessionAccessSourceV1Schema>;

/** One safe display identity, not the complete audience or an authorization input. */
export const SessionAudienceContextV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('team'), teamId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('group'), teamId: z.string().min(1), groupId: z.string().min(1) }).strict(),
]));
export type SessionAudienceContextV1 = z.infer<typeof SessionAudienceContextV1Schema>;

export const SessionEffectiveAccessV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  level: z.enum(['view', 'edit', 'admin', 'owner']),
  sources: z.array(SessionAccessSourceV1Schema),
  capabilities: SessionAccessCapabilitiesV1Schema,
  audienceContext: SessionAudienceContextV1Schema.nullable().optional(),
  /** Authored organizational context never establishes a grant or audience match. */
  primaryTeamId: z.string().min(1).nullable().optional(),
}).strict());
export type SessionEffectiveAccessV1 = z.infer<typeof SessionEffectiveAccessV1Schema>;

export type EffectiveSessionAccessLevelV1 = SessionEffectiveAccessV1['level'];
export type SessionCapabilityV1 = keyof SessionAccessCapabilitiesV1;

export type SessionAccessProjectionRoleV1 = 'owner' | 'recipient' | 'unavailable';

/**
 * Canonical role classification for current Session projections and the
 * released owner/direct compatibility marker. This is representation
 * normalization only: it never decides authorization.
 */
export function readSessionAccessProjectionRoleV1(input: Readonly<{
  effectiveAccess?: unknown;
  share?: unknown;
  metadataLayoutVersion?: unknown;
}>): SessionAccessProjectionRoleV1 {
  if (input.effectiveAccess !== undefined) {
    const parsed = SessionEffectiveAccessV1Schema.safeParse(input.effectiveAccess);
    if (!parsed.success) return 'unavailable';
    return parsed.data.level === 'owner' ? 'owner' : 'recipient';
  }
  if (input.share === null) return 'owner';
  if (input.share !== undefined) return 'recipient';
  return input.metadataLayoutVersion === undefined || input.metadataLayoutVersion === 0
    ? 'owner'
    : 'unavailable';
}

export const SESSION_CAPABILITY_RULES = {
    readTranscript: { level: "view", delegation: false },
    submitAgentInput: { level: "edit", delegation: false },
    editSessionRecords: { level: "edit", delegation: false },
    approveRuntimePermissions: { level: "edit", delegation: true },
    manageAccess: { level: "admin", delegation: false },
    managePermissionDelegation: { level: "admin", delegation: true },
    managePublicLink: { level: "owner", delegation: false },
    archiveSession: { level: "admin", delegation: false },
    renameSession: { level: "admin", delegation: false },
    assignResponsibility: { level: "admin", delegation: false },
    stopSession: { level: "owner", delegation: false },
    deleteSession: { level: "owner", delegation: false },
} as const;
export const SESSION_ACCESS_LEVEL_ORDER: readonly EffectiveSessionAccessLevelV1[] = ["view", "edit", "admin", "owner"];

export type SessionAccessGrantCapabilityValueV1 = Readonly<{
  accessLevel: Exclude<EffectiveSessionAccessLevelV1, 'owner'>;
  canApprovePermissions: boolean;
}>;

/** Each capability must be supported by one qualifying grant, including delegation. */
export function projectSessionAccessCapabilitiesV1(input: {
  owner: boolean;
  grants: readonly SessionAccessGrantCapabilityValueV1[];
}): SessionAccessCapabilitiesV1 {
  return Object.fromEntries(Object.entries(SESSION_CAPABILITY_RULES).map(([capability, rule]) => [
    capability,
    input.owner || input.grants.some(grant =>
      SESSION_ACCESS_LEVEL_ORDER.indexOf(grant.accessLevel) >= SESSION_ACCESS_LEVEL_ORDER.indexOf(rule.level)
      && (!rule.delegation || grant.canApprovePermissions)),
  ])) as SessionAccessCapabilitiesV1;
}

/**
 * Whether replacing one explicit grant row would newly supply any capability
 * whose canonical rule requires permission delegation.
 *
 * This is the shared stored-to-requested transition decision used by mutation
 * admission and by grant-row presentation. Retaining or reducing authority is
 * deliberately not treated as a gain.
 */
export function gainsSessionAccessDelegationCapabilityV1(
  previous: SessionAccessGrantCapabilityValueV1 | null,
  next: SessionAccessGrantCapabilityValueV1,
): boolean {
  const before = projectSessionAccessCapabilitiesV1({
    owner: false,
    grants: previous ? [previous] : [],
  });
  const after = projectSessionAccessCapabilitiesV1({ owner: false, grants: [next] });
  return (Object.keys(SESSION_CAPABILITY_RULES) as SessionCapabilityV1[])
    .some((capability) => SESSION_CAPABILITY_RULES[capability].delegation
      && !before[capability]
      && after[capability]);
}

/** Compatibility presentation for released owner/direct envelopes without effectiveAccess. */
export function projectLegacySessionAccessCapabilitiesV1(input: {
  level: EffectiveSessionAccessLevelV1;
  canApprovePermissions?: boolean;
}): SessionAccessCapabilitiesV1 {
  return projectSessionAccessCapabilitiesV1({
    owner: input.level === 'owner',
    grants: input.level === 'owner' ? [] : [{ accessLevel: input.level, canApprovePermissions: input.canApprovePermissions === true }],
  });
}
