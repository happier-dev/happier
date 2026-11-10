import type { PluginAgentSkillsCapabilityV2 } from '../../../plugins/contributions/v2.js';
import type { CapabilityItemStateV1 } from '../../../reach/resolveSessionCapabilitiesV1.js';
import type { SkillLibraryItemV1 } from './skillLibraryItemV1.js';
import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';

export type NativeSkillScanV1 = Readonly<{
  status: 'ok'; names: readonly Readonly<{ name: string; path: string; root: string }>[];
}> | Readonly<{
  status: 'failed'; roots: readonly string[]; names: readonly Readonly<{ name: string; path: string; root: string }>[];
}>;
const identity = lazyZodSchema(() => z.string().check(z.minLength(1)));
export const SessionSkillPlanV1Schema = lazyZodSchema(() => z.strictObject({
  plan: z.enum(['session_dir', 'index', 'none']),
  items: z.array(z.strictObject({ skillId: identity, name: identity, digest: z.string(),
    state: z.enum(['delivered', 'masked_by_native', 'off', 'excluded', 'name_conflict', 'unavailable']),
    reason: z.enum(['rule_on', 'rule_off', 'no_rule', 'session_added', 'session_removed', 'managed_off', 'not_portable', 'agent_unsupported',
      'native_same_name', 'duplicate_name', 'content_unreadable', 'materialize_failed', 'native_scan_failed']),
    maskedBy: z.optional(z.strictObject({ path: identity })),
  })),
  nativeDisables: z.array(z.strictObject({ name: identity, path: identity, state: z.enum(['applied', 'unsupported']) })),
  diagnostics: z.array(z.strictObject({ kind: z.literal('native_scan_failed'), root: identity })),
}));
export type SessionSkillPlanV1 = z.infer<typeof SessionSkillPlanV1Schema>;

/** Transient Agent SDK delivery, projected from the canonical skill-plan fields. */
export const AgentSessionSkillDeliveryV1Schema = lazyZodSchema(() => z.strictObject({
  pluginRoot: identity,
  skillsRoot: identity,
  items: z.array(z.extend(z.pick(SessionSkillPlanV1Schema.shape.items._zod.def.element, { name: true, skillId: true, digest: true }), {
    directory: identity,
  })),
  nativeDisables: z.array(z.pick(SessionSkillPlanV1Schema.shape.nativeDisables._zod.def.element, { name: true, path: true })),
}));

export function resolveSkillPlanKindV1(input: {
  agentSkills: PluginAgentSkillsCapabilityV2 | null; agentHasActionChannel: boolean;
}): SessionSkillPlanV1['plan'] {
  return input.agentSkills?.delivery === 'session_dir' ? 'session_dir' : input.agentHasActionChannel ? 'index' : 'none';
}

export function resolveSessionSkillPlanV1(input: {
  items: readonly SkillLibraryItemV1[]; selected: readonly CapabilityItemStateV1[];
  excludeNativeSkillNames: readonly string[]; agentSkills: PluginAgentSkillsCapabilityV2 | null;
  agentHasActionChannel: boolean; nativeSkills: NativeSkillScanV1;
}): SessionSkillPlanV1 {
  const plan = resolveSkillPlanKindV1(input);
  const selection = new Map(input.selected.filter(item => item.kind === 'skill').map(item => [item.id, item]));
  const disabled = new Set(input.excludeNativeSkillNames);
  const disableSupported = input.agentSkills?.nativeDisable === 'supported';
  const nativeDisables: SessionSkillPlanV1['nativeDisables'] = input.nativeSkills.names
    .filter(item => disabled.has(item.name))
    .map(item => ({ name: item.name, path: item.path, state: disableSupported ? 'applied' : 'unsupported' }));
  const activeNative = new Map(input.nativeSkills.names.filter(item => !disableSupported || !disabled.has(item.name))
    .map(item => [item.name, item]));
  const newest = new Map<string, SkillLibraryItemV1>();
  const newestFolder = new Map<string, SkillLibraryItemV1>();
  for (const item of input.items) {
    if (!selection.get(item.skillId)?.selected) continue;
    for (const [map, key] of [[newest, item.name], [newestFolder, (item.sourceFolderName ?? item.name).toLowerCase()]] as const) {
      const previous = map.get(key);
      if (!previous || (item.updatedAt ?? 0) > (previous.updatedAt ?? 0)
        || (item.updatedAt ?? 0) === (previous.updatedAt ?? 0) && item.skillId.localeCompare(previous.skillId) > 0) map.set(key, item);
    }
  }
  const items: SessionSkillPlanV1['items'] = input.items.map(item => {
    const selected = selection.get(item.skillId);
    const identity = { skillId: item.skillId, name: item.name, digest: item.digest };
    if (!selected?.selected) return { ...identity, state: selected?.reason === 'session_removed' ? 'excluded' : 'off', reason: selected?.reason ?? 'no_rule' };
    if (plan === 'none') return { ...identity, state: 'unavailable', reason: 'agent_unsupported' };
    const native = activeNative.get(item.name);
    if (native) return { ...identity, state: 'masked_by_native', reason: 'native_same_name', maskedBy: { path: native.path } };
    if (input.nativeSkills.status === 'failed') return { ...identity, state: 'unavailable', reason: 'native_scan_failed' };
    if (newest.get(item.name)?.skillId !== item.skillId
      || plan === 'session_dir' && newestFolder.get((item.sourceFolderName ?? item.name).toLowerCase())?.skillId !== item.skillId)
      return { ...identity, state: 'name_conflict', reason: 'duplicate_name' };
    return { ...identity, state: 'delivered', reason: selected.reason };
  });
  return { plan, items, nativeDisables, diagnostics: input.nativeSkills.status === 'failed'
    ? input.nativeSkills.roots.map(root => ({ kind: 'native_scan_failed', root })) : [] };
}
