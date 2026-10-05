import { describe, expect, it } from 'vitest';
import { PluginInputTypeContributionV1Schema } from '../plugins/contributions/inputTypes.js';
import { WorkflowInputDefinitionSchema, workflowInputToFieldHint } from '../workflows/workflowV1.js';
import { resolveEffectiveInputFields } from './inputFieldRuntime.js';
import { inputTypeOptionsSourceId } from './inputTypes.js';
import { InputFieldHintSchema, normalizeInputHintsText } from './inputFields.js';
import { readInputTypeOptions, validateInputTypeValue, type ResolvedInputTypeV1 } from './inputTypeRuntime.js';

const identity = { pluginId: 'com.acme.inputs', localId: 'repository' };
const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'serving-1', definition:
  PluginInputTypeContributionV1Schema.parse({ id: identity.localId, title: 'Repository', semantic: 'repository',
    valueSchema: { type: 'object', properties: { repositoryId: { type: 'string' } },
      required: ['repositoryId'], additionalProperties: false }, options: { resource: 'repositories' }, picker: 'repository-picker' }) };

describe('typed inputs across consumer domains', () => {
  it('retains the same qualified type in Workflow and neutral Action/widget fields after removal', () => {
    const saved = WorkflowInputDefinitionSchema.parse({ name: 'repository', valueType: 'json', required: true, inputType: identity });
    const workflow = workflowInputToFieldHint(saved);
    const neutral = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };
    expect(InputFieldHintSchema.safeParse({ ...neutral, optionsSourceId: 'session.modes.available' }).success).toBe(false);
    expect(InputFieldHintSchema.safeParse({ ...neutral, options: [{ value: 'a-second-source', label: 'Second' }] }).success).toBe(false);
    expect(InputFieldHintSchema.safeParse({ ...neutral, optionsSourceId: inputTypeOptionsSourceId(identity) }).success).toBe(true);
    for (const field of [workflow, neutral]) {
      expect(resolveEffectiveInputFields({ inputHints: { fields: [field] } }, { repository: { repositoryId: 'saved' } }))
        .toMatchObject([{ inputType: identity }]);
    }
    expect(saved.inputType).toEqual(identity);
  });
  it('does not fabricate an options Resource for a picker-only type in any field adapter', () => {
    const neutral = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };
    const workflow = workflowInputToFieldHint({ name: 'repository', valueType: 'json', required: true, inputType: identity });
    const normalized = normalizeInputHintsText({ fields: [neutral] }, text => text).fields[0]!;
    for (const field of [workflow, normalized, ...resolveEffectiveInputFields({ inputHints: { fields: [neutral] } }, {})]) {
      expect(field.inputType).toEqual(identity);
      expect(field.optionsSourceId).toBeUndefined();
    }
  });
  it('validates semantic refs and primitive choices through the existing self-contained compiler', () => {
    const options = readInputTypeOptions(type, [{ value: { repositoryId: 'one' }, label: 'One' }]);
    expect(options).not.toBeNull();
    expect(validateInputTypeValue(type, { repositoryId: 'one' }, options ?? [])).toMatchObject({ status: 'valid' });
    expect(validateInputTypeValue(type, { repositoryId: 'other' }, options ?? [])).toMatchObject({ status: 'invalid' });
    expect(validateInputTypeValue(type, { repositoryId: 'one', machineId: 'spoof' })).toMatchObject({ status: 'invalid' });
    const numeric = { ...type, definition: { ...type.definition, valueSchema: { type: 'integer' as const } } };
    expect(readInputTypeOptions(numeric, [{ value: 4, label: 'Four' }])).toEqual([{ value: 4, label: 'Four' }]);
  });
});
