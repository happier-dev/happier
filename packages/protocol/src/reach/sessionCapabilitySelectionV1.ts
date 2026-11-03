import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { areSessionMcpSelectionsEquivalent, SessionMcpSelectionAuthoringV1Schema, SessionMcpSelectionV1Schema } from '../mcp/servers/sessionSelectionV1.js';
import type { ReachDecisionV1 } from './resolveReachV1.js';

export const SessionSkillSelectionAuthoringV1Schema = lazyZodSchema(() => z.pipe(z.strictObject({
  v: z._default(z.literal(1), 1), forceIncludeSkillIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  forceExcludeSkillIds: z._default(z.array(z.string().check(z.minLength(1))), []), excludeNativeSkillNames: z._default(z.array(z.string().check(z.minLength(1))), []),
}), z.transform(value => ({ ...value, forceIncludeSkillIds: [...new Set(value.forceIncludeSkillIds)],
  forceExcludeSkillIds: [...new Set(value.forceExcludeSkillIds)], excludeNativeSkillNames: [...new Set(value.excludeNativeSkillNames)] }))));
export const SessionSkillSelectionV1Schema = createStoredReadSchema(SessionSkillSelectionAuthoringV1Schema);
export type SessionSkillSelectionV1 = z.infer<typeof SessionSkillSelectionV1Schema>;
export const SessionCapabilitySelectionAuthoringV1Schema = lazyZodSchema(() => z.strictObject({
  mcp: z.optional(SessionMcpSelectionAuthoringV1Schema), skills: z.optional(SessionSkillSelectionAuthoringV1Schema),
}));
export const SessionCapabilitySelectionV1Schema = createStoredReadSchema(SessionCapabilitySelectionAuthoringV1Schema);
export type SessionCapabilitySelectionV1 = z.infer<typeof SessionCapabilitySelectionV1Schema>;
export type SessionCapabilityKindV1 = 'skill' | 'mcp_server' | 'native_skill';
export type SessionCapabilityOverrideV1 = 'on' | 'off' | 'inherit';

export function readSessionCapabilityOverrideV1(selection: SessionCapabilitySelectionV1,
  kind: SessionCapabilityKindV1, id: string): SessionCapabilityOverrideV1 {
  if (kind === 'native_skill') return selection.skills?.excludeNativeSkillNames.includes(id) ? 'off' : 'inherit';
  const excludes = kind === 'mcp_server' ? selection.mcp?.forceExcludeServerIds : selection.skills?.forceExcludeSkillIds;
  const includes = kind === 'mcp_server' ? selection.mcp?.forceIncludeServerIds : selection.skills?.forceIncludeSkillIds;
  return excludes?.includes(id) ? 'off' : includes?.includes(id) ? 'on' : 'inherit';
}

/** One item writer for drafts, optimistic projections and the Account metadata Action. */
export function setSessionCapabilitySelectionItemV1(selection: SessionCapabilitySelectionV1,
  kind: SessionCapabilityKindV1, id: string, state: SessionCapabilityOverrideV1): SessionCapabilitySelectionV1 {
  const normalized = SessionCapabilitySelectionAuthoringV1Schema.parse(selection);
  if (kind === 'mcp_server') {
    const mcp = SessionMcpSelectionV1Schema.parse(normalized.mcp ?? {});
    return { ...normalized, mcp: { ...mcp,
      forceIncludeServerIds: [...mcp.forceIncludeServerIds.filter(value => value !== id), ...(state === 'on' ? [id] : [])],
      forceExcludeServerIds: [...mcp.forceExcludeServerIds.filter(value => value !== id), ...(state === 'off' ? [id] : [])],
    } };
  }
  const skills = SessionSkillSelectionV1Schema.parse(normalized.skills ?? {});
  return { ...normalized, skills: kind === 'native_skill' ? { ...skills,
    excludeNativeSkillNames: [...skills.excludeNativeSkillNames.filter(value => value !== id), ...(state === 'off' ? [id] : [])],
  } : { ...skills,
    forceIncludeSkillIds: [...skills.forceIncludeSkillIds.filter(value => value !== id), ...(state === 'on' ? [id] : [])],
    forceExcludeSkillIds: [...skills.forceExcludeSkillIds.filter(value => value !== id), ...(state === 'off' ? [id] : [])],
  } };
}
/** The sole ingress fold for the released MCP-only carrier spelling. */
export function readCapabilitySelectionCarrierV1(raw: unknown): SessionCapabilitySelectionV1 | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const carrier = raw as Record<string, unknown>;
  if (carrier.capabilitySelection !== undefined) {
    const parsed = SessionCapabilitySelectionV1Schema.safeParse(carrier.capabilitySelection);
    return parsed.success ? parsed.data : null;
  }
  if (carrier.mcpSelection === undefined || carrier.mcpSelection === null) return null;
  const parsed = SessionMcpSelectionV1Schema.safeParse(carrier.mcpSelection);
  return parsed.success ? { mcp: parsed.data } : null;
}
/** Effective policy equality; omission is the normalized default for each kind. */
export function areSessionCapabilitySelectionsEquivalentV1(
  left: SessionCapabilitySelectionV1 | null | undefined,
  right: SessionCapabilitySelectionV1 | null | undefined,
): boolean {
  if (!areSessionMcpSelectionsEquivalent(
    SessionMcpSelectionV1Schema.parse(left?.mcp ?? {}),
    SessionMcpSelectionV1Schema.parse(right?.mcp ?? {}),
  )) return false;
  const skillKey = (raw: SessionSkillSelectionV1 | undefined) => {
    const skills = SessionSkillSelectionV1Schema.parse(raw ?? {});
    const excluded = new Set(skills.forceExcludeSkillIds);
    return JSON.stringify({
      forceIncludeSkillIds: skills.forceIncludeSkillIds.filter(id => !excluded.has(id)).sort(),
      forceExcludeSkillIds: [...excluded].sort(),
      excludeNativeSkillNames: [...skills.excludeNativeSkillNames].sort(),
    });
  };
  return skillKey(left?.skills) === skillKey(right?.skills);
}
export type CapabilitySelectionReasonV1 = 'rule_on' | 'rule_off' | 'no_rule' | 'session_added' | 'session_removed' | 'managed_off' | 'not_portable' | 'agent_unsupported';

/** Rules choose defaults. Selectability describes actual item/Agent admission, never rule applicability. */
export function applySessionSelectionV1(input: Readonly<{ reach: ReachDecisionV1; selectable: boolean;
  unselectableReason?: CapabilitySelectionReasonV1;
  forceIncluded: boolean; forceExcluded: boolean; managedEnabled: boolean }>): Readonly<{ selected: boolean; reason: CapabilitySelectionReasonV1 }> {
  if (input.forceExcluded) return { selected: false, reason: 'session_removed' };
  if (!input.selectable) return { selected: false, reason: input.unselectableReason ?? 'not_portable' };
  if (input.forceIncluded) return { selected: true, reason: 'session_added' };
  if (!input.managedEnabled) return { selected: false, reason: 'managed_off' };
  return { selected: input.reach.enabled, reason: input.reach.decidedBy ? input.reach.enabled ? 'rule_on' : 'rule_off' : 'no_rule' };
}
