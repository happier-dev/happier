import { describe, expect, it } from 'vitest';
import { PluginInputTypeContributionV1Schema } from '../plugins/contributions/inputTypes.js';
import { WorkflowInputDefinitionSchema, workflowInputToFieldHint } from '../workflows/workflowV1.js';
import { resolveEffectiveInputFields } from './inputFieldRuntime.js';
import { inputTypeOptionsSourceId, parseInputTypeOptionsSourceId } from './inputTypes.js';
import { InputFieldHintSchema, normalizeInputHintsText } from './inputFields.js';
import { readInputTypeOptions, resolveInputTypeOptions, validateHostInputTypeValue, validateInputTypeValue, validateInputFieldValue, type ResolvedInputTypeV1 } from './inputTypeRuntime.js';

const identity = { pluginId: 'com.acme.inputs', localId: 'repository' };
const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'serving-1', definition:
  PluginInputTypeContributionV1Schema.parse({ id: identity.localId, title: 'Repository', semantic: 'repository',
    valueSchema: { type: 'object', properties: { repositoryId: { type: 'string' } },
      required: ['repositoryId'], additionalProperties: false }, options: { resource: 'repositories' }, picker: 'repository-picker' }) };

describe('typed inputs across consumer domains', () => {
  it('refuses unresolved dynamic choices', () => {
    const dynamic = InputFieldHintSchema.parse({ path: 'query', title: 'Usage', widget: 'json',
      inputType: { hostType: 'usageQuery' }, optionsSourceId: 'notifications.channels.available' });
    expect(validateInputFieldValue({ field: dynamic, value: { metric: 'cost' } }))
      .toEqual({ status: 'unavailable', reasonCode: 'input_type_options_unavailable' });
  });
  // Blocked: author grammar remains restrictive until every executable consumer, including CLI, is validated and migrated.
  it('[blocked: authored typed static choices] compares authored options before host normalization', () => {
    const selected = ['two', 'one', 'two'];
    const field = InputFieldHintSchema.parse({ path: 'session', title: 'Sessions', widget: 'select',
      inputType: { hostType: 'usageQuery', field: 'session' }, options: [{ value: selected, label: 'Selected' }] });
    expect(validateInputFieldValue({ field, value: selected })).toEqual({ status: 'valid', value: ['one', 'two'] });
    expect(validateInputFieldValue({ field, value: ['one', 'two'] }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_option_invalid' });
  });
  it('retains Workflow source/type exclusion at its domain admission owner', () => {
    for (const choices of [{ enum: ['allowed'] }, { optionsSourceId: 'notifications.channels.available' }]) {
      expect(WorkflowInputDefinitionSchema.safeParse({ name: 'choice', valueType: 'string', required: true,
        inputType: identity, ...choices }).success).toBe(false);
    }
  });
  it('admits native host reference types through their canonical schemas without inventing plugin options', async () => {
    const session = { serverId: 'home', sessionId: 'B' };
    const workspace = { serverId: 'home', id: 'checkout', machineId: 'machine', rootPath: '/repo', createdAtMs: 0 };
    for (const [hostType, value] of [['session', session], ['workspace', workspace]] as const) {
      const inputType = { hostType };
      const field = { path: 'source', title: 'Source', widget: 'json' as const, inputType };
      expect(InputFieldHintSchema.parse(field)).toEqual(field);
      expect(normalizeInputHintsText({ fields: [field] }, text => text).fields[0]?.inputType).toEqual(inputType);
      expect(validateHostInputTypeValue(inputType, value)).toEqual({ status: 'valid', value });
      expect(validateHostInputTypeValue(inputType, { rootPath: '/repo' }).status).toBe('invalid');
      expect(InputFieldHintSchema.safeParse({ ...field, inputType: { ...inputType, pluginId: 'forged' } }).success).toBe(false);
    }
    expect(inputTypeOptionsSourceId({ hostType: 'session' })).toBe('sessions');
    expect(await resolveInputTypeOptions({ identity: { hostType: 'workspace' }, deps: {}, ctx: {}, readFailure: () => null }))
      .toEqual({ ok: true, result: [], optionsSourceId: null });
  });
  it('admits a host UsageQuery reference without granting a plugin occurrence', () => {
    expect(InputFieldHintSchema.safeParse({ path: 'query', title: 'Usage', widget: 'json', inputType: { hostType: 'usageQuery' } }).success).toBe(true);
    expect(InputFieldHintSchema.safeParse({ path: 'query', title: 'Usage', widget: 'json', inputType: { hostType: 'usageQuery', pluginId: 'forged' } }).success).toBe(false);
    for (const field of ['period', 'session'] as const) {
      const inputType = { hostType: 'usageQuery' as const, field };
      expect(InputFieldHintSchema.parse({ path: field, title: field, widget: 'select', inputType }).inputType).toEqual(inputType);
      expect(parseInputTypeOptionsSourceId(inputTypeOptionsSourceId(inputType))).toEqual(inputType);
    }
    expect(InputFieldHintSchema.safeParse({ path: 'period', title: 'Period', widget: 'select', inputType: { hostType: 'usageQuery', field: 'metric' } }).success).toBe(false);
    expect(InputFieldHintSchema.safeParse({ path: 'session', title: 'Session', widget: 'select', inputType: { hostType: 'session', field: 'session' } }).success).toBe(false);
  });
  it('retains the canonical host query reference in a Workflow editor without inventing choice authority', () => {
    const definition = WorkflowInputDefinitionSchema.parse({ name: 'query', valueType: 'json', required: true,
      inputType: { hostType: 'usageQuery' } });
    expect(workflowInputToFieldHint(definition).inputType).toEqual({ hostType: 'usageQuery' });
    expect(WorkflowInputDefinitionSchema.safeParse({ ...definition, inputType: { hostType: 'usageQuery', accountId: 'forged' } }).success).toBe(false);
  });
  it('preserves declared own-value and follow context modes through shared field normalization', () => {
    const own = { path: 'metric', title: 'Metric', widget: 'text' as const, contextMode: 'own' as const };
    const follow = { ...own, path: 'period', contextMode: 'follow' as const };
    const normalized = normalizeInputHintsText({ fields: [own, follow] }, text => text).fields;
    expect(InputFieldHintSchema.parse(own)).toEqual(own);
    expect(normalized).toEqual([own, follow]);
    expect(resolveEffectiveInputFields({ inputHints: { fields: normalized } }, {}))
      .toMatchObject([{ contextMode: 'own' }, { contextMode: 'follow' }]);
    expect(InputFieldHintSchema.safeParse({ ...own, contextMode: 'other' }).success).toBe(false);
  });
  it('retains the same qualified type in Workflow and neutral Action/widget fields after removal', () => {
    const saved = WorkflowInputDefinitionSchema.parse({ name: 'repository', valueType: 'json', required: true, inputType: identity });
    const workflow = workflowInputToFieldHint(saved);
    const neutral = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };
    expect(InputFieldHintSchema.safeParse({ ...neutral, optionsSourceId: 'session.modes.available' }).success).toBe(false);
    expect(InputFieldHintSchema.safeParse({ ...neutral, options: [{ value: 'a-field-choice', label: 'Choice' }] }).success).toBe(false);
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
