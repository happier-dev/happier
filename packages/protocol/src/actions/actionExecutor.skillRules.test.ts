import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { createActionExecuteFailureError } from './actionExecutionResult.js';
import type { ArtifactSavedByV1 } from '../artifacts/artifactBinaryV1.js';
import type { ArtifactFolderActionPortV1 } from '../prompts/library/promptFolderActionsV1.js';
import type { SkillRuleV1 } from '../reach/reachRuleV1.js';
import { readSkillLibraryCatalog } from '../prompts/library/skills/readSkillLibraryCatalog.js';
import { removeSkillRulesV1 } from '../prompts/library/skillRulesActionsV1.js';

const original: SkillRuleV1 = { id: 'existing', skillId: 'lint-id', target: { t: 'allMachines' }, enabled: false, createdAt: 1, updatedAt: 2 };
const { skillId: _skillId, ...previous } = original;
const request = { items: [{ name: 'lint' }, { skillId: 'review-id' }],
  change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } };
const presentUser = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account' } as const;
const approvedAgent = { ...presentUser, approvedActionReplay: { artifactId: 'approval', origin: {
  surface: 'agent', accountId: 'account', caller: { kind: 'session', sessionId: 'creator-session', starterDepth: 0, turnDepth: 0 },
} } } as const;
function fixture(options: { unavailable?: boolean; conflict?: boolean; inactive?: boolean; sourceCurrentness?: boolean;
  readFailure?: boolean; writeFailure?: boolean; unrelatedUnreadable?: boolean; creator?: ArtifactSavedByV1;
  initialRules?: SkillRuleV1[] } = {}) {
  let rules = options.initialRules ?? [original];
  const writes: Array<Parameters<ArtifactFolderActionPortV1['writeRecord']>[0]> = [];
  const port = {
    serverId: 'home', assertCurrent: () => {},
    readCatalog: async () => {
      if (options.readFailure) throw createActionExecuteFailureError({ ok: false, errorCode: 'forbidden', error: 'Home transport failed' });
      return { catalog: options.unavailable
      ? { status: 'partial' as const, rows: [], tombstones: [], diagnostics: [{ key: 'skill-rules' as const, revision: 3, reason: 'invalid-stored-content' as const }] }
      : { status: 'ready' as const, rows: options.inactive ? [] : [{ record: { key: 'skill-rules' as const, value: { v: 1 as const, rules,
        consumedLegacyEntryIds: ['migrated-stack:account:legacy-lint'] } }, revision: 3 }], tombstones: [], diagnostics: [] },
      ...(options.inactive ? { rawSettings: {}, ...(options.sourceCurrentness ? { sourceSettingsVersion: 7 } : {}) } : {}) };
    },
    writeRecord: async (input: Parameters<ArtifactFolderActionPortV1['writeRecord']>[0]) => {
      writes.push(input);
      if (options.writeFailure) throw createActionExecuteFailureError({ ok: false, errorCode: 'forbidden', error: 'Home transport failed' });
      if (options.conflict) return { status: 'conflict' as const, revision: 4 };
      if (input.record.key === 'skill-rules') rules = input.record.value.rules;
      return { status: 'updated' as const, revision: 4, cursor: 1 };
    },
    // Artifact persistence is substituted; the inventory and frontmatter owner remain real.
    listSkills: (signal?: AbortSignal, skillIds?: readonly string[]) => {
      const items = [['lint-id', 'lint'], ['review-id', 'review']].map(([artifactId, name]) => ({ artifactId: artifactId!,
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' },
        ...(options.creator ? { provenance: { savedBy: { kind: 'person' as const, accountId: 'later-editor' }, skillCreator: options.creator } } : {}),
        body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8',
          contentBase64: Buffer.from(`---\nname: ${name}\n---\nUse it.`).toString('base64') }] }),
      }));
      if (options.unrelatedUnreadable) items.push({ artifactId: 'unrelated', header: items[0]!.header, body: 'unreadable' });
      return readSkillLibraryCatalog({ list: async () => ({ coverage: 'complete', items }),
        read: async id => items.find(item => item.artifactId === id) ?? null }, signal, skillIds);
    },
    ruleWriteContext: () => ({ nowMs: 8, newId: () => 'new' }),
  };
  const deps = { skillRules: port } satisfies ActionExecutorDeps;
  return { executor: createActionExecutor(deps), port, writes, rules: () => rules };
}
describe('skill rules Action through prompt-library CAS', () => {
  // OWNER-RULINGS 2026-11-05 Bot templates (5), X2: ordinary approval authorizes widening.
  it('widens an agent-created skill after ordinary approval', async () => {
    const f = fixture({ creator: { kind: 'agent', accountId: 'account', sessionId: 'creator-session' }, unrelatedUnreadable: true });
    // Use the addressed read: unrelated unreadable content must not change admission.
    const input = { ...request, items: [{ skillId: 'lint-id' }] };
    const result = await f.executor.execute('skills.rules.set', input, approvedAgent);
    expect(result, result.ok ? undefined : result.errorCode)
      .toMatchObject({ ok: true, result: { ok: true, items: [{ skillId: 'lint-id', rules: [{ enabled: true }] }] } });
    expect(f.rules()).toMatchObject([{ skillId: 'lint-id', enabled: true }]);
    expect(f.writes).toHaveLength(1);
  });
  it('preserves approval policy for legacy, person and non-Session creators', async () => {
    for (const creator of [undefined, { kind: 'person', accountId: 'account' }, { kind: 'agent', accountId: 'account' }] as const) {
      const f = fixture({ creator });
      expect(await f.executor.execute('skills.rules.set', request, approvedAgent)).toMatchObject({ ok: true, result: { ok: true } });
    }
  });
  it('permits approved removal of a disabled exception alongside unchanged or narrower reach', async () => {
    const creator = { kind: 'agent', accountId: 'account', sessionId: 'creator-session' } as const;
    const enabled: SkillRuleV1 = { ...original, enabled: true };
    const exception: SkillRuleV1 = { ...original, id: 'exception', target: { t: 'machine', machineId: 'machine' } };
    const f = fixture({ creator, initialRules: [enabled, exception] });
    const items = [{ skillId: 'lint-id' }];
    expect(await f.executor.execute('skills.rules.set', { items, change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } } }, approvedAgent))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await f.executor.execute('skills.rules.set', { items, change: { kind: 'write', write: { place: exception.target, state: 'inherit' } } }, approvedAgent))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(f.rules()).toEqual([enabled]);
    expect(await f.executor.execute('skills.rules.set', { items, change: { kind: 'write', write: { place: { t: 'allMachines' }, state: 'off' } } }, approvedAgent))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await f.executor.execute('skills.rules.set', { items, change: { kind: 'replace', rules: [] } }, approvedAgent))
      .toMatchObject({ ok: true, result: { ok: true } });
  });
  it('changes an addressed skill without opening unrelated library content and still refuses an absent id', async () => {
    const f = fixture({ unrelatedUnreadable: true });
    const change = { kind: 'write', write: { place: { t: 'allMachines' }, state: 'on' } };
    expect(await f.executor.execute('skills.rules.set', { items: [{ skillId: 'lint-id' }], change }, presentUser))
      .toMatchObject({ ok: true, result: { ok: true, items: [{ skillId: 'lint-id' }] } });
    expect(await f.executor.execute('skills.rules.set', { items: [{ skillId: 'missing' }], change }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
  });
  it('preserves consumed legacy identity when a place is removed or the skill is deleted', async () => {
    const f = fixture();
    await f.executor.execute('skills.rules.set', { items: [{ skillId: 'lint-id' }], change: { kind: 'replace', rules: [] } }, presentUser);
    expect(f.writes[0]?.record.value).toMatchObject({ rules: [], consumedLegacyEntryIds: ['migrated-stack:account:legacy-lint'] });
    const deleted = fixture();
    expect(await removeSkillRulesV1(deleted.port, 'lint-id')).toBe(true);
    expect(deleted.writes[0]?.record.value).toMatchObject({ rules: [], consumedLegacyEntryIds: ['migrated-stack:account:legacy-lint'] });
  });
  it('resolves names and ids and writes every item atomically with the previous rules for Undo', async () => {
    const f = fixture();
    expect(await f.executor.execute('skills.rules.set', request, { ...presentUser, serverId: 'home' })).toEqual({ ok: true, result: {
      ok: true, revision: 4, items: [
        { skillId: 'lint-id', previous: [previous], rules: [{ ...previous, enabled: true, updatedAt: 8 }] },
        { skillId: 'review-id', previous: [], rules: [{ id: 'new', target: { t: 'allMachines' }, enabled: true, createdAt: 8, updatedAt: 8 }] },
      ],
    } });
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.expectedRevision).toBe(3);
    expect(f.rules().map(rule => rule.skillId)).toEqual(['lint-id', 'review-id']);
  });
  it('keeps the catalog reason when stored rules cannot be read', async () => {
    const f = fixture({ unavailable: true });
    expect(await f.executor.execute('skills.rules.set', request, presentUser))
      .toMatchObject({ ok: false, errorCode: 'invalid-stored-content', error: 'invalid-stored-content' });
    expect(f.writes).toEqual([]);
  });
  it('refuses missing captured source currentness', async () => {
    const options = { inactive: true };
    const f = fixture(options);
    expect(await f.executor.execute('skills.rules.set', request, presentUser)).toEqual({ ok: true, result: { ok: false, code: 'catalog_unavailable' } });
    expect(f.writes).toEqual([]);
  });
  it('returns a lost CAS as conflict without replaying or publishing success', async () => {
    const f = fixture({ conflict: true });
    expect(await f.executor.execute('skills.rules.set', request, presentUser)).toEqual({ ok: true, result: { ok: false, code: 'conflict' } });
    expect(f.rules()).toEqual([original]);
    expect(f.writes).toHaveLength(1);
  });
  it.each([{ readFailure: true }, { writeFailure: true }])('projects catalog transport failure through the closed Action result', async options => {
    const f = fixture(options);
    expect(await f.executor.execute('skills.rules.set', request, presentUser))
      .toMatchObject({ ok: false, errorCode: 'forbidden', error: 'Home transport failed' });
    expect(f.rules()).toEqual([original]);
  });
  it('refuses missing items and multi-item replacement without writing any item', async () => {
    const f = fixture();
    expect(await f.executor.execute('skills.rules.set', { ...request, items: [{ name: 'missing' }] }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'not_found' } });
    expect(await f.executor.execute('skills.rules.set', { ...request, change: { kind: 'replace', rules: [] } }, presentUser))
      .toEqual({ ok: true, result: { ok: false, code: 'replace_needs_one_item' } });
    expect(f.writes).toEqual([]);
  });
});
