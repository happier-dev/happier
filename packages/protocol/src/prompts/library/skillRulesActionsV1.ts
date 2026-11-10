import type { z } from '../../zodRuntimePolicy.js';
import { SkillsRulesSetInputV1Schema, type SkillsRulesSetOutputV1Schema } from '../../actions/specs/capabilityRules.js';
import { applyReachRulesChangeV1, type ReachRulesWriteContextV1 } from '../../reach/reachRulesChangeV1.js';
import type { ReachRuleV1, SkillRuleV1 } from '../../reach/reachRuleV1.js';
import { readPromptLibraryCatalogRecordV1, type PromptLibraryStackActionPortV1 } from './promptLibraryCatalogV1.js';

export type SkillRulesActionPortV1 = PromptLibraryStackActionPortV1 & Readonly<{
  listSkills(signal?: AbortSignal, skillIds?: readonly string[]): Promise<readonly Readonly<{ id: string; name: string }>[]>;
  ruleWriteContext(): ReachRulesWriteContextV1;
}>;

export async function readSkillRulesForItemV1(port: SkillRulesActionPortV1, skillId: string, signal?: AbortSignal): Promise<readonly SkillRuleV1[]> {
  signal?.throwIfAborted(); port.assertCurrent();
  const projection = await port.readCatalog(signal, 'skill-rules');
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
  if (read.status !== 'ready' || read.record.key !== 'skill-rules') throw Object.assign(new Error('catalog_unavailable'), { code: 'catalog_unavailable' });
  return read.record.value.rules.filter(rule => rule.skillId === skillId);
}

/** Content deletion may already be acknowledged; an absent item still needs its inert rules removed. */
export async function removeSkillRulesV1(port: SkillRulesActionPortV1, skillId: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted(); port.assertCurrent();
  const projection = await port.readCatalog(signal, 'skill-rules');
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
  if (read.status !== 'ready' || read.record.key !== 'skill-rules'
    || read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) return false;
  if (!read.record.value.rules.some(rule => rule.skillId === skillId)) return true;
  const rules = read.record.value.rules.filter(rule => rule.skillId !== skillId);
  signal?.throwIfAborted(); port.assertCurrent();
  const result = await port.writeRecord({ record: { key: 'skill-rules', value: { ...read.record.value, rules } }, expectedRevision: read.revision,
    ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) }, signal);
  return result.status === 'updated';
}

/** Reach intent is applied once to the reviewed row and committed by its existing CAS. */
export async function mutateSkillRulesV1(port: SkillRulesActionPortV1,
  request: z.infer<typeof SkillsRulesSetInputV1Schema>, signal?: AbortSignal,
): Promise<z.infer<typeof SkillsRulesSetOutputV1Schema>> {
  const input = SkillsRulesSetInputV1Schema.parse(request);
  if (input.change.kind === 'replace' && input.items.length !== 1) return { ok: false, code: 'replace_needs_one_item' };
  const assertCurrent = () => { signal?.throwIfAborted(); port.assertCurrent(); };
  const unavailable = (cause: unknown) => {
    assertCurrent();
    if (cause instanceof Error && (cause.name === 'AbortError'
      || 'code' in cause && (cause.code === 'scope-retired' || cause.code === 'cancelled'))) throw cause;
    return { ok: false, code: 'catalog_unavailable' } as const;
  };
  assertCurrent();
  let projection: Awaited<ReturnType<SkillRulesActionPortV1['readCatalog']>>;
  let library: Awaited<ReturnType<SkillRulesActionPortV1['listSkills']>>;
  try {
    // Both authenticated observations are independent. Keep their latency off
    // each other's critical path; no rule is written until both are admitted.
    [projection, library] = await Promise.all([
      port.readCatalog(signal, 'skill-rules'),
      port.listSkills(signal, input.items.every(item => 'skillId' in item)
        ? input.items.flatMap(item => 'skillId' in item ? [item.skillId] : []) : undefined),
    ]);
  }
  catch (cause) { return unavailable(cause); }
  assertCurrent();
  const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'skill-rules' });
  if (read.status !== 'ready' || read.record.key !== 'skill-rules'
    || read.authority === 'inactive' && projection.sourceSettingsVersion === undefined) return { ok: false, code: 'catalog_unavailable' };
  const retainedRules = read.record.value.rules;
  const ids = new Set<string>();
  for (const item of input.items) {
    const matches = library.filter(skill => 'skillId' in item ? skill.id === item.skillId : skill.name === item.name);
    if (matches.length !== 1) return { ok: false, code: 'not_found' };
    ids.add(matches[0]!.id);
  }
  const ctx = port.ruleWriteContext();
  const items = [...ids].map(skillId => {
    const previous: ReachRuleV1[] = retainedRules.filter(rule => rule.skillId === skillId)
      .map(({ skillId: _skillId, ...rule }) => rule);
    return { skillId, previous, rules: applyReachRulesChangeV1(previous, input.change, ctx) };
  });
  const rules = [...retainedRules.filter(rule => !ids.has(rule.skillId)),
    ...items.flatMap(item => item.rules.map(rule => ({ ...rule, skillId: item.skillId })))];
  assertCurrent();
  let result: Awaited<ReturnType<SkillRulesActionPortV1['writeRecord']>>;
  try {
    result = await port.writeRecord({ record: { key: 'skill-rules', value: { ...read.record.value, rules } }, expectedRevision: read.revision,
      ...(read.authority === 'inactive' ? { sourceSettingsVersion: projection.sourceSettingsVersion } : {}) }, signal);
  } catch (cause) { return unavailable(cause); }
  // A consumed durable receipt survives subsequent caller cancellation or Home retirement.
  if (result.status === 'updated') return { ok: true, items, revision: result.revision };
  return { ok: false, code: result.status === 'conflict' || result.status === 'settings-conflict' ? 'conflict' : 'catalog_unavailable' };
}
