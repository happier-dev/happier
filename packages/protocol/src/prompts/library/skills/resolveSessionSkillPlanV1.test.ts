import { describe, expect, it } from 'vitest';
import { resolveSessionSkillPlanV1, resolveSkillPlanKindV1, SessionSkillPlanV1Schema } from './resolveSessionSkillPlanV1.js';
import type { SkillLibraryItemV1 } from './skillLibraryItemV1.js';
import type { CapabilityItemStateV1 } from '../../../reach/resolveSessionCapabilitiesV1.js';

const capability = { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' } as const;
const item = (skillId: string, name = 'sample', updatedAt = 1): SkillLibraryItemV1 => ({
  skillId, name, updatedAt, digest: `sha256:${skillId}`, description: 'A sample skill', disableModelInvocation: false, userInvocable: true,
});
const selected = (id: string, enabled = true): CapabilityItemStateV1 => ({
  kind: 'skill', id, name: 'sample', selected: enabled, reachEnabled: enabled, selectable: true,
  reason: enabled ? 'rule_on' : 'no_rule', decidedBy: null, sessionOverride: null,
});
const resolve = (input: Partial<Parameters<typeof resolveSessionSkillPlanV1>[0]> = {}) => SessionSkillPlanV1Schema.parse(resolveSessionSkillPlanV1({
  items: [item('library')], selected: [selected('library')], excludeNativeSkillNames: [],
  agentSkills: capability, agentHasActionChannel: true, nativeSkills: { status: 'ok', names: [] }, ...input,
}));

describe('resolveSessionSkillPlanV1', () => {
  it('masks selected library content with a native same-name path', () => {
    expect(resolve({ nativeSkills: { status: 'ok', names: [{ name: 'sample', path: '/native/sample/SKILL.md', root: '/native' }] } }).items)
      .toEqual([expect.objectContaining({ skillId: 'library', state: 'masked_by_native', reason: 'native_same_name', maskedBy: { path: '/native/sample/SKILL.md' } })]);
  });
  it('delivers only the newest selected item with a duplicate name, without renaming', () => {
    const plan = resolve({ items: [item('older'), item('newer', 'sample', 2)], selected: [selected('older'), selected('newer')] });
    expect(plan.items.map(value => [value.skillId, value.name, value.state])).toEqual([
      ['older', 'sample', 'name_conflict'], ['newer', 'sample', 'delivered'],
    ]);
  });
  it('never selects an item that P2 did not select', () => {
    expect(resolve({ items: [item('off'), item('absent')], selected: [selected('off', false)] }).items.map(value => value.state)).toEqual(['off', 'off']);
  });
  it('resolves source-folder collisions by newest update then skill id without changing declared names', () => {
    const items = [
      { ...item('older', 'declared-a', 1), sourceFolderName: 'Shared' },
      { ...item('a', 'declared-b', 2), sourceFolderName: 'shared' },
      item('z', 'shared', 2),
    ];
    for (const ordered of [items, [...items].reverse()]) {
      const plan = resolve({ items: ordered, selected: items.map(value => selected(value.skillId)) });
      expect(plan.items.filter(value => value.state === 'delivered').map(value => value.skillId)).toEqual(['z']);
      expect(plan.items.filter(value => value.skillId !== 'z').every(value => value.state === 'name_conflict')).toBe(true);
    }
    expect(resolve({ items, selected: items.map(value => selected(value.skillId)), agentSkills: null }).items.every(value => value.state === 'delivered')).toBe(true);
  });
  it('preserves known masking while withholding all other selected items on a failed scan', () => {
    const plan = resolve({ items: [item('masked'), item('unknown', 'other')], selected: [selected('masked'), selected('unknown')],
      nativeSkills: { status: 'failed', roots: ['/unreadable'], names: [{ name: 'sample', path: '/native/sample/SKILL.md', root: '/native' }] } });
    expect(plan.items.map(value => [value.state, value.reason])).toEqual([
      ['masked_by_native', 'native_same_name'], ['unavailable', 'native_scan_failed'],
    ]);
    expect(plan.diagnostics).toEqual([{ kind: 'native_scan_failed', root: '/unreadable' }]);
  });
  it('reports unsupported native disables without passing them as applied', () => {
    const plan = resolve({ agentSkills: { ...capability, nativeDisable: 'unsupported' }, excludeNativeSkillNames: ['sample'],
      nativeSkills: { status: 'ok', names: [{ name: 'sample', path: '/native/sample/SKILL.md', root: '/native' }] } });
    expect(plan.nativeDisables).toEqual([{ name: 'sample', path: '/native/sample/SKILL.md', state: 'unsupported' }]);
    expect(plan.items[0]?.state).toBe('masked_by_native');
  });
  it('unmasks a native name only when the Agent supports its disable overlay', () => {
    const plan = resolve({ excludeNativeSkillNames: ['sample'], nativeSkills: { status: 'ok', names: [{ name: 'sample', path: '/native/sample/SKILL.md', root: '/native' }] } });
    expect(plan.nativeDisables[0]?.state).toBe('applied');
    expect(plan.items[0]?.state).toBe('delivered');
  });
  it('delivers invocation-disabled items natively and leaves index filtering to its renderer', () => {
    expect(resolve({ items: [{ ...item('library'), disableModelInvocation: true }] }).items[0]?.state).toBe('delivered');
  });
  it('does not claim delivery for an Agent without a skill or Action channel', () => {
    expect(resolve({ agentSkills: null, agentHasActionChannel: false }).items[0]).toMatchObject({ state: 'unavailable', reason: 'agent_unsupported' });
  });
});

describe('resolveSkillPlanKindV1', () => {
  it('uses the manifest knob, otherwise the real Action channel', () => {
    expect(resolveSkillPlanKindV1({ agentSkills: capability, agentHasActionChannel: false })).toBe('session_dir');
    expect(resolveSkillPlanKindV1({ agentSkills: null, agentHasActionChannel: true })).toBe('index');
    expect(resolveSkillPlanKindV1({ agentSkills: null, agentHasActionChannel: false })).toBe('none');
  });
});
