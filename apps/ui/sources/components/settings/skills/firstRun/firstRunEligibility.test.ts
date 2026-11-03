import { describe, expect, it } from 'vitest';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildFirstPartySkillSeedRuleV1 } from '@happier-dev/protocol/prompts/library/skills/firstPartySkillsV1';
import { resolveSkillsFirstVisit } from './firstRunEligibility';
import { buildSkillsFirstRunSelection } from './skillsFirstRunSelection';

const item = SkillListItemV1Schema.parse({ skillId: 'review', name: 'review', description: null, revision: '1:1',
  rules: [], trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 0 }, provenance: { kind: 'written' },
  modified: false, updatePolicy: 'manual', createdAt: 1, migratedFromContext: false, userInvocable: true, folderId: null });
const seed = buildFirstPartySkillSeedRuleV1('happier:happier', 1);
const bundled = { ...item, skillId: seed.skillId, name: 'happier', provenance: { kind: 'first_party' as const }, rules: [seed] };

describe('first-run current default reach', () => {
  it('keeps an existing Account eligible when new built-ins have no persisted rules', () => {
    const later = { ...bundled, skillId: 'happier:workflows', name: 'workflows', rules: [] };
    expect(resolveSkillsFirstVisit([item, bundled, later], { rules: [seed], decidedAt: null })).toEqual({ on: 0, off: 1 });
    expect(later.rules).toEqual([]);
  });
  it('allows only migrated rules and the exact unmodified seed, and honors device dismissal', () => {
    expect(resolveSkillsFirstVisit([item, bundled], { rules: [seed], decidedAt: null })).toEqual({ on: 0, off: 1 });
    expect(resolveSkillsFirstVisit([item, bundled], { rules: [seed], decidedAt: 0 })).toBeNull();
    expect(resolveSkillsFirstVisit([item, bundled], { rules: [seed, { ...seed, id: 'personal', skillId: 'deleted' }], decidedAt: null })).toBeNull();
  });
  it.each([
    { ...seed, enabled: false },
    { ...seed, target: { t: 'project' as const, projectKey: 'work' } },
    { ...seed, agentId: 'claude' },
    { ...seed, updatedAt: 2 },
  ])('ends eligibility when the built-in seed was changed', rule => {
    expect(resolveSkillsFirstVisit([item, { ...bundled, rules: [rule] }], { rules: [rule], decidedAt: null })).toBeNull();
  });
  it('ends eligibility for an extra project rule on the built-in skill', () => {
    const personal = { ...seed, id: 'personal', target: { t: 'project' as const, projectKey: 'work' } };
    expect(resolveSkillsFirstVisit([item, { ...bundled, rules: [seed, personal] }], { rules: [seed, personal], decidedAt: null })).toBeNull();
    const migrated = { ...personal, id: 'migrated-stack:project:built-in' };
    expect(resolveSkillsFirstVisit([item, { ...bundled, rules: [seed, migrated] }], { rules: [seed, migrated], decidedAt: null })).toBeNull();
  });
  it('never offers a plugin\'s skill to the person to choose: it is host-owned like the built-in one', () => {
    const pluginOwned = { ...item, skillId: 'plugin:acme/check', name: 'check', provenance: { kind: 'plugin' as const, pluginId: 'acme', occurrenceId: 'o1' } };
    expect(resolveSkillsFirstVisit([pluginOwned, bundled], { rules: [seed], decidedAt: null })).toBeNull();
    expect(buildSkillsFirstRunSelection([pluginOwned, item]).items.map(row => row.skillId)).toEqual(['review']);
  });
  it('ranks used Off skills most recent first, preselects them and preserves unused library order', () => {
    const older = { ...item, skillId: 'older', lastUsedAt: 1 };
    const recent = { ...item, skillId: 'recent', lastUsedAt: 2 };
    const never = { ...item, skillId: 'never' };
    const zero = { ...item, skillId: 'zero', lastUsedAt: 0 };
    const result = buildSkillsFirstRunSelection([item, older, never, recent, bundled, zero]);
    expect(result.items.map(row => row.skillId)).toEqual(['recent', 'older', 'zero', 'review', 'never']);
    expect(result.preselectedIds).toEqual(['recent', 'older', 'zero']);
    expect(buildSkillsFirstRunSelection([item, never]).preselectedIds).toEqual([]);
  });
});
