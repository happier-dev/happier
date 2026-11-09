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
  it('admits a new string alongside suggested choices only when custom values are declared', () => {
    const descriptor = { path: 'profileId', title: 'Profile', widget: 'select' as const,
      optionsSourceId: 'browser.profiles.available', allowCustomValue: true };
    const field = InputFieldHintSchema.parse(descriptor);
    const normalized = normalizeInputHintsText({ fields: [field] }, text => text).fields[0]!;
    const options = [{ value: 'work', label: 'Work' }];
    for (const value of ['work', 'new-profile']) {
      expect(validateInputFieldValue({ field: normalized, value, options })).toEqual({ status: 'valid', value });
    }
    expect(validateInputFieldValue({ field, value: 'new-profile' })).toEqual({ status: 'valid', value: 'new-profile' });
    const staticSuggestions = InputFieldHintSchema.parse({ ...descriptor, optionsSourceId: undefined, options });
    expect(validateInputFieldValue({ field: staticSuggestions, value: 'new-profile' }))
      .toEqual({ status: 'valid', value: 'new-profile' });
    expect(validateInputFieldValue({ field, value: { profileId: 'new-profile' }, options }).status).toBe('invalid');
    const constrainedType: ResolvedInputTypeV1 = { ...type, definition: PluginInputTypeContributionV1Schema.parse({
      id: identity.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'string', enum: ['allowed'] },
    }) };
    expect(validateInputFieldValue({ field: { ...field, inputType: identity }, type: constrainedType, value: 'new-profile' }).status).toBe('invalid');
    const resourceType: ResolvedInputTypeV1 = { ...constrainedType, definition: PluginInputTypeContributionV1Schema.parse({
      id: identity.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' },
      options: { resource: 'repositories' },
    }) };
    const typedField = { ...field, inputType: identity };
    expect(validateInputFieldValue({ field: typedField, type: resourceType, value: 'new-profile' }))
      .toEqual({ status: 'unavailable', reasonCode: 'input_type_options_unavailable' });
    expect(validateInputFieldValue({ field: typedField, type: resourceType, value: 'new-profile', options }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_option_invalid' });
    expect(validateInputFieldValue({ field: typedField, type: resourceType, value: 'work', options }))
      .toEqual({ status: 'valid', value: 'work' });
    const strict = InputFieldHintSchema.parse({ ...descriptor, allowCustomValue: false });
    expect(validateInputFieldValue({ field: strict, value: 'new-profile', options }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_option_invalid' });
    expect(InputFieldHintSchema.safeParse({ ...descriptor, widget: 'multiselect' }).success).toBe(false);
    expect(InputFieldHintSchema.safeParse({ ...descriptor, widget: 'text' }).success).toBe(false);
  });
  it('normalizes a Bot to its executable Session and preserves ordered participant lists', () => {
    const session = { serverId: 'home-b', sessionId: 'bot-session' };
    const scalar = workflowInputToFieldHint(WorkflowInputDefinitionSchema.parse({
      name: 'answerer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' },
    }));
    const list = workflowInputToFieldHint(WorkflowInputDefinitionSchema.parse({
      name: 'reviewers', valueType: 'json', multiple: true, required: true,
      inputType: { hostType: 'agentParticipant' },
    }));
    expect(scalar.widget).toBe('select');
    expect(list.widget).toBe('multiselect');
    expect(validateInputFieldValue({ field: scalar, value: { kind: 'bot', session } })).toEqual({
      status: 'valid', value: { kind: 'session', session },
    });
    expect(validateInputFieldValue({ field: list, value: [
      { kind: 'bot', session }, { kind: 'session', session: { serverId: 'home-b', sessionId: 'other' } },
    ] })).toMatchObject({ status: 'valid', value: [
      { kind: 'session', session }, { kind: 'session', session: { serverId: 'home-b', sessionId: 'other' } },
    ] });
    expect(validateInputFieldValue({ field: scalar, value: { kind: 'person', personId: 'p' } }).status).toBe('invalid');
  });
  it('admits only a closed Home-qualified machine value through the shared host input owner', () => {
    const field = InputFieldHintSchema.parse({ path: 'machine', title: 'Machine', widget: 'select', inputType: { hostType: 'machine' } });
    const reference = field.inputType!;
    expect(inputTypeOptionsSourceId(reference)).toBe('host-input:machine');
    expect(parseInputTypeOptionsSourceId('host-input:machine')).toEqual(reference);
    const machine = { serverId: 'home', machineId: 'offline-machine' };
    expect(validateInputFieldValue({ field, value: machine })).toEqual({ status: 'valid', value: machine });
    for (const invalid of [{ machineId: 'unqualified' }, { serverId: '', machineId: 'm' }, { ...machine, accountId: 'forged' }]) {
      expect(validateInputFieldValue({ field, value: invalid }).status).toBe('invalid');
    }
  });
  it('retains a declared option localization key through normalization without changing value admission', () => {
    const field = InputFieldHintSchema.parse({ path: 'effect', title: 'Effect', widget: 'select', options: [
      { value: 'stop', label: 'Stop', labelKey: 'actionPresentation.options.stop' },
    ] });
    const normalized = normalizeInputHintsText({ fields: [field] }, text => `Localized ${text}`).fields[0]!;
    expect(normalized.options?.[0]).toMatchObject({ value: 'stop', label: 'Localized Stop', labelKey: 'actionPresentation.options.stop' });
    expect(validateInputFieldValue({ field: normalized, value: 'stop' })).toEqual({ status: 'valid', value: 'stop' });
    expect(validateInputFieldValue({ field: normalized, value: 'Localized Stop' }).status).toBe('invalid');
  });
  it('normalizes an optional setup prompt without replacing the noun title or changing value admission', () => {
    const fields = [{ path: 'repository', title: 'Repository', prompt: 'Which repository?', widget: 'text' as const },
      { path: 'branch', title: 'Branch', widget: 'text' as const }];
    const normalized = normalizeInputHintsText({ fields }, text => `Localized ${text}`);
    expect(normalized.fields).toMatchObject([
      { title: 'Localized Repository', prompt: 'Localized Which repository?' },
      { title: 'Localized Branch' },
    ]);
    expect(normalized.fields[1]).not.toHaveProperty('prompt');
    expect(resolveEffectiveInputFields({ inputHints: normalized }, {})).toMatchObject(normalized.fields);
    expect(validateInputFieldValue({ field: normalized.fields[0]!, value: 'repo' })).toEqual({ status: 'valid', value: 'repo' });
    expect(InputFieldHintSchema.safeParse({ ...fields[0], prompt: ' ' }).success).toBe(false);
  });
  it('refuses unresolved dynamic choices', () => {
    const dynamic = InputFieldHintSchema.parse({ path: 'query', title: 'Usage', widget: 'json',
      inputType: { hostType: 'usageQuery' }, optionsSourceId: 'notifications.channels.available' });
    expect(validateInputFieldValue({ field: dynamic, value: { metric: 'cost' } }))
      .toEqual({ status: 'unavailable', reasonCode: 'input_type_options_unavailable' });
  });
  it('shows a stored value without its choices: they are needed to pick a value, not to show one', () => {
    const field = InputFieldHintSchema.parse({ path: 'repository', title: 'Repository', widget: 'select', inputType: identity });
    const stored = { repositoryId: 'one' };
    // Unreachable or still-loading choices never retire a value that was admitted when it was written...
    expect(validateInputFieldValue({ field, type, value: stored, storedValue: true })).toEqual({ status: 'valid', value: stored });
    // ...a malformed value still fails its schema...
    expect(validateInputFieldValue({ field, type, value: { repositoryId: 1 }, storedValue: true }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
    // ...and known choices that no longer name it retire it, exactly as before.
    expect(validateInputFieldValue({ field, type, value: stored, storedValue: true, options: [{ value: { repositoryId: 'two' }, label: 'Two' }] }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_option_invalid' });
    // A write still fails closed until its choices are known.
    expect(validateInputFieldValue({ field, type, value: stored })).toEqual({ status: 'unavailable', reasonCode: 'input_type_options_unavailable' });
  });
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
  it('preserves host-slot visibility independently of draft predicates and value admission', () => {
    const field = InputFieldHintSchema.parse({ path: 'detail', title: 'Detail', widget: 'text',
      visibleWhenContextSlot: 'selection', visibleWhen: { op: 'truthy', path: 'enabled' } });
    const normalized = normalizeInputHintsText({ fields: [field] }, text => text);
    expect(resolveEffectiveInputFields({ inputHints: normalized }, { enabled: true }, { contextSlots: [] })).toEqual([]);
    expect(resolveEffectiveInputFields({ inputHints: normalized }, { enabled: false }, { contextSlots: ['selection'] })).toEqual([]);
    expect(resolveEffectiveInputFields({ inputHints: normalized }, { enabled: true }, { contextSlots: ['selection'] }))
      .toMatchObject([{ path: 'detail', visible: true }]);
    expect(validateInputFieldValue({ field, value: 'retained' })).toEqual({ status: 'valid', value: 'retained' });
  });
  it('retains the same qualified type in Workflow and neutral Action/widget fields after removal', () => {
    const saved = WorkflowInputDefinitionSchema.parse({ name: 'repository', valueType: 'json', required: true, inputType: identity });
    const workflow = workflowInputToFieldHint(saved);
    const neutral = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };
    expect(InputFieldHintSchema.safeParse({ ...neutral, optionsSourceId: 'session.modes.available' }).success).toBe(true);
    expect(InputFieldHintSchema.safeParse({ ...neutral, options: [{ value: 'a-field-choice', label: 'Choice' }] }).success).toBe(true);
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
  it('never admits a static choice outside the type schema or a disabled multiselection', () => {
    const field = InputFieldHintSchema.parse({ path: 'repository', title: 'Repositories', widget: 'multiselect',
      inputType: identity, options: [{ value: { repositoryId: 'one' }, label: 'One' },
        { value: { repositoryId: 'two' }, label: 'Two', disabled: true },
        { value: { repositoryId: 'one', machineId: 'forged' }, label: 'Forged' }] });
    const options = [{ value: { repositoryId: 'one' }, label: 'One' }];
    expect(validateInputFieldValue({ field, type, options, value: [{ repositoryId: 'one' }] }))
      .toEqual({ status: 'valid', value: [{ repositoryId: 'one' }] });
    expect(validateInputFieldValue({ field, type, options, value: [{ repositoryId: 'one' }, { repositoryId: 'two' }] }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_option_invalid' });
    expect(validateInputFieldValue({ field, type, options, value: [{ repositoryId: 'one', machineId: 'forged' }] }))
      .toEqual({ status: 'invalid', reasonCode: 'input_type_value_invalid' });
    expect(validateInputFieldValue({ field, value: [{ repositoryId: 'one' }] }))
      .toEqual({ status: 'unavailable', reasonCode: 'input_type_unavailable' });
    expect(validateInputFieldValue({ field, type, value: [{ repositoryId: 'one' }] }))
      .toEqual({ status: 'unavailable', reasonCode: 'input_type_options_unavailable' });
  });
});
