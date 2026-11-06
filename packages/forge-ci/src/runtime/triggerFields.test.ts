import { describe, expect, it } from 'vitest';
import type { ForgeCiTriggerDefinitionV1 } from '@happier-dev/triage-protocol/ci/v1';
import { projectForgeCiTriggerFieldsV1, reconcileForgeCiTriggerDraftV1, updateForgeCiTriggerDraftV1, readForgeCiTriggerValuesV1, admitForgeCiTriggerDefinitionV1 } from './triggerFields.js';

function definition(inputs: ForgeCiTriggerDefinitionV1['inputs'], revision = 'sha'): ForgeCiTriggerDefinitionV1 {
  return { workflowId: 'ci', ref: 'main', revision, dispatchable: true, inputs };
}

describe('canonical trigger field projection and open drafts', () => {
  it('maps through Form hints with safe slots while preserving exact dangerous-looking native keys, false, zero and omission', () => {
    const projection = projectForgeCiTriggerFieldsV1({ definition: definition([
      { name: 'a.b', type: 'boolean', default: true }, { name: '__proto__', type: 'number', default: 4 },
      { name: 'constructor.prototype.x', type: 'string' }, { name: 'omitted', type: 'string', default: 'provider-default' },
    ]) });
    expect(projection.formHints.fields.map(field => [field.path, field.widget])).toEqual([
      ['fields.f0', 'boolean'], ['fields.f1', 'number'], ['fields.f2', 'text'], ['fields.f3', 'text'],
    ]);
    const draft = reconcileForgeCiTriggerDraftV1({ projection, values: Object.fromEntries([['a.b', false], ['__proto__', 0], ['constructor.prototype.x', 'exact']]) });
    const result = readForgeCiTriggerValuesV1(draft);
    expect(result).toEqual({ kind: 'value', value: Object.fromEntries([['a.b', false], ['__proto__', 0], ['constructor.prototype.x', 'exact']]) });
    expect(Object.hasOwn(result.kind === 'value' ? result.value : {}, 'omitted')).toBe(false);
    expect({}).not.toHaveProperty('x');
    expect(draft.input).toMatchObject({ fields: { f0: false, f1: 0, f2: 'exact', f3: 'provider-default' } });
  });

  it('keeps equal field/option identities and unchanged draft; typing never reprojects or seeds', () => {
    const def = definition([{ name: 'mode', type: 'choice', options: ['one', 'two'] }, { name: 'count', type: 'number' }]);
    const first = projectForgeCiTriggerFieldsV1({ definition: def });
    const draft = reconcileForgeCiTriggerDraftV1({ projection: first, values: { mode: 'two', count: 0 } });
    const equal = projectForgeCiTriggerFieldsV1({ definition: structuredClone(def), baseline: first });
    expect(equal).toBe(first);
    expect(reconcileForgeCiTriggerDraftV1({ projection: equal, baseline: draft })).toBe(draft);
    const typed = updateForgeCiTriggerDraftV1(draft, { fields: { f0: 'two', f1: '-' } });
    expect(typed.projection).toBe(first);
    expect(readForgeCiTriggerValuesV1(typed)).toMatchObject({ kind: 'unavailable', issues: [{ name: 'count', reason: 'invalid_value' }] });
    const zero = updateForgeCiTriggerDraftV1(typed, { fields: { f0: 'two', f1: 0 } });
    expect(readForgeCiTriggerValuesV1(zero)).toEqual({ kind: 'value', value: { mode: 'two', count: 0 } });
  });

  it('preserves compatible explicit values by native name/type across reorder but requires review for removed fields/options/types', () => {
    const first = projectForgeCiTriggerFieldsV1({ definition: definition([{ name: 'mode', type: 'choice', options: ['one', 'two'] }, { name: 'count', type: 'number' }]) });
    const draft = reconcileForgeCiTriggerDraftV1({ projection: first, values: { mode: 'two', count: 0 } });
    const reordered = projectForgeCiTriggerFieldsV1({ definition: definition([{ name: 'count', type: 'number' }, { name: 'mode', type: 'choice', options: ['one', 'two'] }], 'new') , baseline: first });
    expect(reordered.formHints.fields[0]).toBe(first.formHints.fields[1]);
    expect(readForgeCiTriggerValuesV1(reconcileForgeCiTriggerDraftV1({ projection: reordered, baseline: draft }))).toEqual({ kind: 'value', value: { count: 0, mode: 'two' } });
    const changed = projectForgeCiTriggerFieldsV1({ definition: definition([{ name: 'mode', type: 'choice', options: ['one'] }], 'newer'), baseline: reordered });
    const reviewed = reconcileForgeCiTriggerDraftV1({ projection: changed, baseline: draft });
    expect(readForgeCiTriggerValuesV1(reviewed)).toMatchObject({ kind: 'unavailable', issues: expect.arrayContaining([{ name: 'mode', reason: 'changed_options' }, { name: 'count', reason: 'removed_field' }]) });
    expect(readForgeCiTriggerValuesV1(reconcileForgeCiTriggerDraftV1({ projection: changed, values: { mode: 'one' } }))).toEqual({ kind: 'value', value: { mode: 'one' } });
  });

  it('keeps empty/denied environment options typed and never substitutes free text or a malformed select', () => {
    const def = definition([{ name: 'env', type: 'environment', required: true }]);
    const empty = projectForgeCiTriggerFieldsV1({ definition: def, environmentOptions: { kind: 'available', values: [] } });
    expect(empty.formHints.fields).toEqual([]);
    expect(empty.unavailable).toEqual([{ name: 'env', reason: 'options_empty' }]);
    const denied = projectForgeCiTriggerFieldsV1({ definition: def, environmentOptions: { kind: 'unavailable', failure: { class: 'permission', code: 'denied' } } });
    expect(denied.unavailable).toEqual([{ name: 'env', reason: 'options_unavailable', failure: { class: 'permission', code: 'denied' } }]);
    expect(readForgeCiTriggerValuesV1(reconcileForgeCiTriggerDraftV1({ projection: denied }))).toMatchObject({ kind: 'unavailable' });
  });

  it('ignores late old-ref/old-revision definitions at the selected-ref boundary', () => {
    const def = definition([]);
    expect(admitForgeCiTriggerDefinitionV1({ workflowId: 'ci', ref: 'other', revision: 'sha' }, def)).toBeNull();
    expect(admitForgeCiTriggerDefinitionV1({ workflowId: 'ci', ref: 'main', revision: 'next' }, def)).toBeNull();
    expect(admitForgeCiTriggerDefinitionV1({ workflowId: 'ci', ref: 'main', revision: 'sha' }, def)).toBe(def);
  });

  it('admits changed native job facts while retaining form fields, options and an unfinished explicit draft without reseeding', () => {
    const original: ForgeCiTriggerDefinitionV1 = { ...definition([
      { name: 'mode', type: 'choice', options: ['one', 'two'], default: 'one' }, { name: 'count', type: 'number', default: 4 },
    ]), jobs: [{ id: 'test', needs: [], runsOn: ['linux', 'x64'] }, { id: 'package', needs: ['test'], runsOn: 'dynamic' }] };
    const first = projectForgeCiTriggerFieldsV1({ definition: original });
    const explicit = reconcileForgeCiTriggerDraftV1({ projection: first, values: { mode: 'two', count: 0 } });
    const draft = updateForgeCiTriggerDraftV1(explicit, { fields: { f0: 'two', f1: '-' } });
    const changes: readonly NonNullable<ForgeCiTriggerDefinitionV1['jobs']>[] = [
      [{ id: 'test', needs: ['prepare'], runsOn: ['linux', 'x64'] }],
      [{ id: 'test', needs: [], runsOn: 'dynamic' }],
      [{ id: 'renamed-native-job', needs: [], runsOn: ['linux'] }],
      [{ id: 'test', needs: [], runsOn: ['x64', 'linux'] }],
      [{ id: 'package', needs: ['test'], runsOn: 'dynamic' }, { id: 'test', needs: [], runsOn: ['linux', 'x64'] }],
      [],
    ];
    for (const jobs of changes) {
      const nextDefinition: ForgeCiTriggerDefinitionV1 = { ...structuredClone(original), jobs };
      const projection = projectForgeCiTriggerFieldsV1({ definition: nextDefinition, baseline: first });
      expect(projection.definition.jobs).toEqual(jobs);
      expect(projection.formHints).toBe(first.formHints);
      expect(projection.formHints.fields[0]?.options).toBe(first.formHints.fields[0]?.options);
      expect(projection.bindings).toBe(first.bindings);
      const continued = reconcileForgeCiTriggerDraftV1({ projection, baseline: draft });
      expect(continued.projection).toBe(projection);
      expect(continued.input).toBe(draft.input);
      expect(continued.values).toBe(draft.values);
      expect(continued.issues).toBe(draft.issues);
      expect(readForgeCiTriggerValuesV1(continued)).toMatchObject({ kind: 'unavailable', issues: [{ name: 'count', reason: 'invalid_value' }] });
    }
    const noJobs = projectForgeCiTriggerFieldsV1({ definition: definition(original.inputs), baseline: first });
    expect(noJobs.definition.jobs).toBeUndefined();
    expect(projectForgeCiTriggerFieldsV1({ definition: structuredClone(original), baseline: first })).toBe(first);
  });
});
