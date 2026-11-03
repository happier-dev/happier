import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_SKILLS_V1, buildFirstPartySkillSeedRuleV1 } from './firstPartySkillsV1.js';
import { computePromptBundleDigestV1 } from '../promptLibraryDigests.js';
import { readSkillBundleContentV1 } from '../promptBundleSchemas.js';
import { resolveSessionCapabilitiesV1 } from '../../../reach/resolveSessionCapabilitiesV1.js';
import { readSkillLibraryCatalog } from './readSkillLibraryCatalog.js';
import { listActionSpecs } from '../../../actions/actionSpecs.js';
import { decodeBase64 } from '../../../crypto/base64.js';
import { resolveSessionSkillPlanV1 } from './resolveSessionSkillPlanV1.js';
import { projectReachForMachinesV1 } from '../../../reach/projectReachV1.js';

describe('first-party bundled skills', () => {
  const context = { machineId: 'machine', machinePlatform: 'posix' as const, directory: null, projectKey: null, agentId: 'claude' };
  it('projects the same implicit defaults and explicit off on Windows and POSIX Machines for the UI', () => {
    const machines = [{ machineId: 'win', platform: 'win32' as const, agentIds: ['claude'] },
      { machineId: 'linux', platform: 'posix' as const, agentIds: ['claude'] }];
    const skill = { skillId: 'happier:workflows', isFeatureEnabled: () => true };
    expect(projectReachForMachinesV1([], { machines, skill }).every(row => row.agents[0]?.enabled)).toBe(true);
    const rules = [{ ...buildFirstPartySkillSeedRuleV1(skill.skillId, 100), enabled: false }];
    expect(projectReachForMachinesV1(rules, { machines, skill }).every(row => !row.agents[0]?.enabled)).toBe(true);
    expect(projectReachForMachinesV1([], { machines, skill: { ...skill, isFeatureEnabled: () => false } })
      .every(row => !row.agents[0]?.enabled)).toBe(true);
  });
  it('enables later built-ins for existing Accounts without adding reach rules, while explicit off survives', () => {
    const rules = [buildFirstPartySkillSeedRuleV1('happier:happier', 100)];
    const selected = resolveSessionCapabilitiesV1({ context, mcp: null, skills: { items: FIRST_PARTY_SKILLS_V1, rules },
      isFeatureEnabled: () => true, selection: {}, agentAcceptsUserMcp: false });
    expect(selected.skills.items.filter(item => item.selected).map(item => item.id)).toEqual([
      'happier:happier', 'happier:deploy', 'happier:workflows',
    ]);
    const off = { ...buildFirstPartySkillSeedRuleV1('happier:workflows', 101), enabled: false };
    expect(resolveSessionCapabilitiesV1({ context, mcp: null, skills: { items: FIRST_PARTY_SKILLS_V1, rules: [...rules, off] },
      isFeatureEnabled: () => true, selection: {}, agentAcceptsUserMcp: false }).skills.items.find(item => item.id === off.skillId)?.selected).toBe(false);
    expect(rules).toHaveLength(1);
  });
  it('excludes feature-disabled built-ins from the Session plan, including a Session force-include', () => {
    const selected = resolveSessionCapabilitiesV1({ context, mcp: null, skills: { items: FIRST_PARTY_SKILLS_V1, rules: [] },
      isFeatureEnabled: () => false, selection: { skills: { v: 1, forceIncludeSkillIds: ['happier:deploy', 'happier:workflows'],
        forceExcludeSkillIds: [], excludeNativeSkillNames: [] } }, agentAcceptsUserMcp: false }).skills.items;
    const items = FIRST_PARTY_SKILLS_V1.map(skill => ({ skillId: skill.skillId, name: skill.name, digest: '', description: skill.description,
      disableModelInvocation: false, userInvocable: true }));
    const plan = resolveSessionSkillPlanV1({ items, selected, excludeNativeSkillNames: [], agentSkills: null,
      agentHasActionChannel: true, nativeSkills: { status: 'ok', names: [] } });
    expect(plan.items.filter(item => item.state === 'delivered').map(item => item.skillId)).toEqual(['happier:happier']);
  });
  it('keeps every backticked Action reference in every first-party SKILL.md current', () => {
    const actionIds = new Set(listActionSpecs().map(spec => spec.id));
    for (const skill of FIRST_PARTY_SKILLS_V1) for (const file of skill.files.filter(file => file.path === 'SKILL.md')) {
      const text = new TextDecoder().decode(decodeBase64(file.contentBase64, 'base64'));
      const ids = [...text.matchAll(/`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)`/g)].map(match => match[1]!);
      for (const id of ids) expect(actionIds.has(id), `${skill.skillId}: ${id}`).toBe(true);
    }
  });
  it('makes built-in and plugin identities selectable through the canonical names/ids catalog without an Artifact', async () => {
    const plugin = { skillId: 'plugin:external.skills/guide', files: FIRST_PARTY_SKILLS_V1[0]!.files,
      provenance: { kind: 'plugin' as const, pluginId: 'external.skills', occurrenceId: 'occurrence-1' } };
    const store = { list: async () => ({ items: [], coverage: 'complete' as const }),
      read: async () => { throw new Error('Read-only skills have no Artifact'); }, readPluginSkills: async () => [plugin] };
    const catalog = await readSkillLibraryCatalog(store);
    expect(catalog).toContainEqual({ id: 'happier:happier', name: 'happier' });
    expect(catalog).toContainEqual({ id: plugin.skillId, name: 'happier' });
    expect(await readSkillLibraryCatalog(store, undefined, [plugin.skillId])).toEqual([{ id: plugin.skillId, name: 'happier' }]);
  });
  it('supplies a valid stable stub through the same bundle and reach consumers', () => {
    const skill = FIRST_PARTY_SKILLS_V1.find(item => item.skillId === 'happier:happier');
    expect(skill).toBeDefined();
    if (!skill) throw new Error('Missing first-party stub');
    const body = { v: 1 as const, entries: [...skill.files], createdAtMs: 0, updatedAtMs: 0 };
    const content = readSkillBundleContentV1({ header: { v: 1, kind: 'prompt_bundle.v2', title: skill.description,
      bundleSchemaId: 'skills.skill_md_v1' }, body: JSON.stringify(body) });
    expect(content).not.toBeNull();
    expect(content?.frontmatter.name).toBe('happier');
    expect(content?.digest).toBe(computePromptBundleDigestV1({ ...body, updatedAtMs: 999 }));
    const selected = resolveSessionCapabilitiesV1({ context: { machineId: 'machine', machinePlatform: 'posix', directory: null,
      projectKey: null, agentId: 'claude' }, mcp: null, skills: { items: [skill], rules: [buildFirstPartySkillSeedRuleV1(skill.skillId, 100)] },
      selection: {}, agentAcceptsUserMcp: false });
    expect(selected.skills.items).toMatchObject([{ id: skill.skillId, selected: true }]);
  });
});
