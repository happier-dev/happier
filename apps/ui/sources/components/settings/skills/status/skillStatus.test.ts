import { describe, expect, it } from 'vitest';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { buildSkillsNeedsALook, skillStatus, skillNeedsALook } from './skillStatus';

const day = 86_400_000, nowMs = 100 * day;
const item = SkillListItemV1Schema.parse({ skillId: 'review', name: 'review', description: null, revision: '1:1',
  rules: [], trust: 'text_only', cost: { descriptionTokens: 0, bodyTokens: 0 }, provenance: { kind: 'written' },
  modified: false, updatePolicy: 'manual', createdAt: 40 * day, migratedFromContext: false, userInvocable: true, folderId: null });

describe('skill status usage truth', () => {
  it('shows admitted built-ins as on without seed writes, and retains explicit off', () => {
    const builtIn = { ...item, skillId: 'happier:workflows', provenance: { kind: 'first_party' as const } };
    expect(skillStatus(builtIn)).not.toContainEqual({ kind: 'off' });
    expect(skillStatus({ ...builtIn, rules: [{ id: 'off', skillId: builtIn.skillId, target: { t: 'allMachines' },
      enabled: false, createdAt: 1, updatedAt: 1 }] })).toContainEqual({ kind: 'off' });
    expect(builtIn.rules).toEqual([]);
  });
  it('keeps Session delivery failures and native masks with the canonical skill status owner', () => {
    const plan = { plan: 'session_dir' as const, nativeDisables: [], diagnostics: [], items: [{ skillId: item.skillId, name: item.name,
      digest: 'digest', state: 'masked_by_native' as const, reason: 'native_same_name' as const, maskedBy: { path: '/native/review' } }] };
    expect(skillStatus(item, undefined, { skillId: item.skillId, plan, notices: [], machineName: 'MacBook', onFix() {} })).toContainEqual({ kind: 'masked', machineName: 'MacBook' });
    expect(skillStatus(null, undefined, { skillId: item.skillId, plan: null, notices: [{ v: 1, items: [{ kind: 'skill', name: item.name, itemId: item.skillId, code: 'materialize_failed' }] }],
      machineName: 'MacBook', onFix() {} })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'error', machineName: 'MacBook' })]));
    // A stored code is never shown as words; a known reason reads as the transcript notice says it.
    const failure = (detail?: string) => skillStatus(null, undefined, { skillId: item.skillId, plan: null, machineName: 'MacBook', onFix() {},
      notices: [{ v: 1, items: [{ kind: 'skill', name: item.name, itemId: item.skillId, code: 'skills_unavailable', ...(detail ? { detail } : {}) }] }] })
      .find(status => status.kind === 'error');
    expect(failure()?.detail).toBeUndefined();
    expect(failure('launch_path_unsupported')?.detail).not.toMatch(/_/);
  });
  it.each([
    { lastUsedAt: nowMs - 31 * day, observed: nowMs - 31 * day, createdAt: item.createdAt, unused: true },
    { lastUsedAt: nowMs - 29 * day, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: nowMs - 30 * day, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 10 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: item.createdAt, unused: true },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: nowMs - 5 * day, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 30 * day, createdAt: item.createdAt, unused: false },
    { lastUsedAt: undefined, observed: nowMs - 40 * day, createdAt: nowMs - 30 * day, unused: false },
    { lastUsedAt: undefined, observed: null, createdAt: item.createdAt, unused: false },
    { lastUsedAt: nowMs - 31 * day, observed: null, createdAt: item.createdAt, unused: false },
  ])('uses observed timestamps at the strict 30-day boundary ($unused)', ({ lastUsedAt, observed, createdAt, unused }) => {
    const current = { ...item, lastUsedAt, createdAt };
    expect(skillStatus(current, { nowMs, usageObservedSince: observed }).some(status => status.kind === 'unused')).toBe(unused);
    expect(skillStatus(current, { nowMs, usageObservedSince: observed }).some(status => status.kind === 'off')).toBe(true);
    expect(skillNeedsALook(current)).toBe(false);
  });
});

describe('needs a look', () => {
  const named = (name: string, over: Partial<typeof item> = {}) => ({ ...item, skillId: name, name, ...over });
  it('joins unreadable library items and machine copies that win, most blocking first, each skill once', () => {
    const entries = buildSkillsNeedsALook(
      [named('update', { upstream: { state: 'update_available' } }), named('masked'), named('plain'),
        named('both', { upstream: { state: 'update_available' } })],
      [{ skillId: 'broken', title: 'broken', reason: 'skill_content_unavailable' }, { skillId: 'gone', title: null, reason: 'not_found' }],
      new Map([['masked', 'MacBook Pro'], ['both', 'nl2']]),
    );
    expect(entries.map((entry) => [entry.kind, entry.key])).toEqual([
      ['unreadable', 'broken'], ['update', 'update'], ['update', 'both'], ['masked', 'masked'],
    ]);
    expect(entries.find((entry) => entry.kind === 'masked')).toMatchObject({ machineName: 'MacBook Pro' });
  });
});
