import { isReadOnlySkillProvenanceV1, type SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { FIRST_PARTY_SKILLS_V1, buildFirstPartySkillSeedRuleV1, resolveSkillReachV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { isMigratedReachRuleIdV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';

function isDefaultRule(rule: SkillRuleV1): boolean {
  if (!FIRST_PARTY_SKILLS_V1.some(skill => skill.skillId === rule.skillId)) return isMigratedReachRuleIdV1(rule.id);
  const seed = buildFirstPartySkillSeedRuleV1(rule.skillId, rule.createdAt);
  const defaultReach = resolveSkillReachV1(rule.skillId, [], { machineId: '', machinePlatform: null,
    directory: null, projectKey: null, agentId: null }, () => true);
  return rule.id === seed.id && rule.target.t === 'allMachines' && rule.agentId === undefined
    && rule.enabled === defaultReach.enabled && rule.updatedAt === seed.updatedAt;
}

/** Current Account rules end this moment on every device; dismissal is device-local. */
export function resolveSkillsFirstVisit(items: readonly SkillListItemV1[], input: Readonly<{
  rules: readonly SkillRuleV1[]; decidedAt: number | null;
}>): Readonly<{ on: number; off: number }> | null {
  if (input.decidedAt !== null) return null;
  const ruleless = items.filter(item => item.rules.length === 0 && !isReadOnlySkillProvenanceV1(item.provenance));
  if (ruleless.length === 0) return null;
  if (!input.rules.every(isDefaultRule)) return null;
  return { on: items.filter(item => !isReadOnlySkillProvenanceV1(item.provenance) && item.migratedFromContext
    && item.rules.some(rule => rule.enabled)).length, off: ruleless.length };
}
