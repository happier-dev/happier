import type { PromptArtifactRefV1 } from '../promptArtifactRefsV1.js';
import type { PromptStackEntryV1 } from '../promptStacksV1.js';
import { isPromptStackSystemAppendPlacementV1 } from '../promptPlacementV1.js';
import { PromptBundleArtifactHeaderV1Schema } from '../promptBundleShapeV1.js';
import { MIGRATED_STACK_RULE_ID_PREFIX_V1, reachRuleKeyV1 } from '../../../reach/reachRulesChangeV1.js';
import type { SkillRuleV1 } from '../../../reach/reachRuleV1.js';
import type { SkillRulesRecordV1 } from '../promptLibrarySchemasV1.js';

export type StackSkillMigrationLayerV1 = Readonly<{ kind: 'account' | 'profile' | 'session' | 'voice' }>
  | Readonly<{ kind: 'project'; projectKey: string }>;
export type StackSkillMigrationOptionsV1 = Readonly<{
  skillIds: ReadonlySet<string>;
  disabledInheritedEntries?: readonly PromptStackEntryV1[];
  disabledInheritedEntryIds?: readonly string[];
}>;

function candidate(entry: PromptStackEntryV1): boolean {
  return entry.ref.kind === 'bundle' && isPromptStackSystemAppendPlacementV1(entry.placement);
}

function ruleIdFor(layer: StackSkillMigrationLayerV1, entryId: string): string | null {
  return layer.kind === 'account' ? `${MIGRATED_STACK_RULE_ID_PREFIX_V1}account:${entryId}`
    : layer.kind === 'project' ? `${MIGRATED_STACK_RULE_ID_PREFIX_V1}project:${layer.projectKey}:${entryId}` : null;
}

/** Destination-row consumption is scoped by layer and Project, never by shared Source. */
export function unconsumedStackSkillEntriesV1(entries: readonly PromptStackEntryV1[],
  layer: Readonly<{ kind: 'account' }> | Extract<StackSkillMigrationLayerV1, { kind: 'project' }>,
  consumedLegacyEntryIds: readonly string[] = []): PromptStackEntryV1[] {
  const consumed = new Set(consumedLegacyEntryIds);
  return entries.filter(entry => candidate(entry) && entry.enabled && entry.skillMigrationV1 !== true
    && !consumed.has(ruleIdFor(layer, entry.id)!));
}

/** Classification reads the Artifact authority before any destination or source mutation. */
export async function readStackSkillIdsV1(entries: readonly PromptStackEntryV1[], port: Readonly<{
  readArtifact(ref: PromptArtifactRefV1): Promise<Readonly<{ header: unknown }> | null>;
}>): Promise<Readonly<{ status: 'ready'; skillIds: ReadonlySet<string> }> | Readonly<{ status: 'unavailable' }>> {
  const seen = new Set<string>();
  const refs = entries.filter(entry => {
    if (!candidate(entry)) return false;
    const key = JSON.stringify([entry.ref.serverId ?? null, entry.ref.artifactId]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(entry => entry.ref);
  // Independent authorities must all be classified, but one slow read need not gate the others.
  const opened = await Promise.all(refs.map(async ref => {
    try { return PromptBundleArtifactHeaderV1Schema.safeParse((await port.readArtifact(ref))?.header); }
    catch { return null; }
  }));
  if (opened.some(header => !header?.success)) return { status: 'unavailable' };
  return { status: 'ready', skillIds: new Set(refs.filter((_ref, index) => {
    const header = opened[index];
    return header?.success && header.data.bundleSchemaId === 'skills.skill_md_v1';
  }).map(ref => ref.artifactId)) };
}

/** IR-100 retains coding entries as inert exclusion custody; D32 drops Voice skills. */
export function convertStackSkillEntriesV1(entries: readonly PromptStackEntryV1[], layer: StackSkillMigrationLayerV1,
  options: StackSkillMigrationOptionsV1): Readonly<{
    remainingEntries: PromptStackEntryV1[]; skillIds: string[]; excludedSkillIds: string[];
    ruleIdFor(entryId: string): string | null;
  }> {
  const isSkill = (entry: PromptStackEntryV1) => candidate(entry) && options.skillIds.has(entry.ref.artifactId);
  const converted = entries.filter(entry => isSkill(entry) && entry.enabled && entry.skillMigrationV1 !== true);
  const excluded = layer.kind === 'session' ? (options.disabledInheritedEntries ?? [])
    .filter(entry => (options.disabledInheritedEntryIds ?? []).includes(entry.id) && isSkill(entry)) : [];
  return {
    remainingEntries: layer.kind === 'voice' ? entries.filter(entry => !isSkill(entry))
      : entries.map(entry => converted.includes(entry) ? { ...entry, skillMigrationV1: true as const } : entry),
    skillIds: layer.kind === 'voice' ? [] : [...new Set(converted.map(entry => entry.ref.artifactId))],
    excludedSkillIds: [...new Set(excluded.map(entry => entry.ref.artifactId))],
    ruleIdFor: entryId => ruleIdFor(layer, entryId),
  };
}

/** Existing user choices win; the strict catalog admits one rule per skill/place/Agent. */
export function appendMigratedStackSkillRulesV1(rules: readonly SkillRuleV1[], entries: readonly PromptStackEntryV1[],
  layer: Extract<StackSkillMigrationLayerV1, { kind: 'project' }> | Readonly<{ kind: 'account' }>,
  options: Readonly<{ skillIds: ReadonlySet<string>; nowMs: number }>): SkillRuleV1[] {
  return migrateStackSkillRulesV1({ v: 1, rules: [...rules] }, entries, layer, options).rules;
}

/** Rules and consumption commit together, including entries already covered by a user rule. */
export function migrateStackSkillRulesV1(value: SkillRulesRecordV1, entries: readonly PromptStackEntryV1[],
  layer: Extract<StackSkillMigrationLayerV1, { kind: 'project' }> | Readonly<{ kind: 'account' }>,
  options: Readonly<{ skillIds: ReadonlySet<string>; nowMs: number }>): SkillRulesRecordV1 {
  entries = unconsumedStackSkillEntriesV1(entries, layer, value.consumedLegacyEntryIds);
  const converted = convertStackSkillEntriesV1(entries, layer, options);
  const target = layer.kind === 'account' ? { t: 'allMachines' as const } : { t: 'project' as const, projectKey: layer.projectKey };
  const targetKey = reachRuleKeyV1({ target });
  const next = [...value.rules];
  const consumed = new Set(value.consumedLegacyEntryIds);
  for (const entry of entries) {
    if (!entry.enabled || entry.skillMigrationV1 === true || !candidate(entry) || !converted.skillIds.includes(entry.ref.artifactId)) continue;
    consumed.add(converted.ruleIdFor(entry.id)!);
    if (next.some(rule => rule.skillId === entry.ref.artifactId && reachRuleKeyV1(rule) === targetKey)) continue;
    next.push({ id: converted.ruleIdFor(entry.id)!, skillId: entry.ref.artifactId, target, enabled: true,
      createdAt: options.nowMs, updatedAt: options.nowMs });
  }
  if (next.length === value.rules.length && consumed.size === (value.consumedLegacyEntryIds?.length ?? 0)) return value;
  return { ...value, rules: next, consumedLegacyEntryIds: [...consumed] };
}

