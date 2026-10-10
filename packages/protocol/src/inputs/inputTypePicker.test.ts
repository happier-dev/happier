import { describe, expect, it } from 'vitest';
import { invokeInputTypePicker, type InputTypePickerHostV1 } from './inputTypePicker.js';
import type { ResolvedInputTypeV1 } from './inputTypeRuntime.js';
import { USAGE_QUERY_INPUT_FIELDS } from './usageQuery.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { InputFieldHintSchema } from './inputFields.js';

const identity = { pluginId: 'com.acme.inputs', localId: 'repository' };
const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'one', definition: {
  id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' },
  options: { resource: 'repositories' }, picker: 'repository-picker',
} };
const field = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };

describe('host-admitted input type picker', () => {
  // Blocked: the public field grammar cannot safely admit these combinations before the CLI consumer is migrated.
  it('[blocked: authored contributed constraints] enforces consuming static and dynamic constraints for a picker-only contributed type', async () => {
    const pickerOnly = { ...type, definition: { ...type.definition, options: undefined } };
    let answer = 'excluded';
    const host: InputTypePickerHostV1 = {
      resolveType: async () => pickerOnly,
      resolveOptions: async () => [{ value: 'allowed', label: 'Allowed' }],
      openPicker: async () => ({ kind: 'completed', input: answer }),
    };
    for (const constraint of [
      { options: [{ value: 'allowed', label: 'Allowed' }] },
      { optionsSourceId: 'notifications.channels.available' },
    ]) {
      const constrained = InputFieldHintSchema.parse({ ...field, ...constraint });
      answer = 'excluded';
      expect(await invokeInputTypePicker({ field: constrained, host, signal: new AbortController().signal }))
        .toEqual({ status: 'error', reasonCode: 'input_type_option_invalid' });
      answer = 'allowed';
      expect(await invokeInputTypePicker({ field: constrained, host, signal: new AbortController().signal }))
        .toEqual({ status: 'selected', value: 'allowed' });
    }
  });
  it('intersects a host type schema with its consuming external source', async () => {
    const field = InputFieldHintSchema.parse({ path: 'query', title: 'Usage', widget: 'json',
      inputType: { hostType: 'usageQuery' }, optionsSourceId: 'notifications.channels.available' });
    let answer: JsonValue = { metric: 'tokens' };
    const host: InputTypePickerHostV1 = {
      resolveType: async () => { throw new Error('A host input does not resolve a plugin'); },
      resolveOptions: async () => [{ value: { metric: 'cost' }, label: 'Cost' },
        { value: { metric: 'invalid' }, label: 'Invalid schema' }],
      openPicker: async () => { throw new Error('A host input does not mount a plugin'); },
      openHostPicker: async () => ({ kind: 'completed', input: answer }),
    };
    const request = { field, host, signal: new AbortController().signal };
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'error', reasonCode: 'input_type_option_invalid' });
    answer = { metric: 'invalid' };
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'error', reasonCode: 'input_type_value_invalid' });
    answer = { metric: 'cost' };
    expect(await invokeInputTypePicker(request)).toMatchObject({ status: 'selected', value: { metric: 'cost' } });
  });
  it('selects independently declared Usage period and Session values through the same typed picker owner', async () => {
    let answer: unknown;
    const host: InputTypePickerHostV1 = {
      resolveType: async () => { throw new Error('Usage fields are host inputs'); },
      resolveOptions: async () => { throw new Error('Usage fields have no plugin Resource'); },
      openPicker: async () => { throw new Error('Usage fields have no plugin picker'); },
      openHostPicker: async () => answer,
    };
    for (const [path, value, expected] of [
      ['period', { startMs: 100, endMs: 200 }, { startMs: 100, endMs: 200 }],
      ['session', ['two', 'one', 'two'], ['one', 'two']],
      ['session', null, null],
    ] satisfies [string, JsonValue, JsonValue][]) {
      const field = USAGE_QUERY_INPUT_FIELDS.find(candidate => candidate.path === path)!;
      answer = { kind: 'completed', input: value };
      expect(await invokeInputTypePicker({ field, host, signal: new AbortController().signal }))
        .toEqual({ status: 'selected', value: expected });
      answer = { kind: 'completed', input: { serverId: 'other', sessionId: 'one' } };
      expect(await invokeInputTypePicker({ field, host, signal: new AbortController().signal }))
        .toMatchObject({ status: 'error', reasonCode: 'input_type_value_invalid' });
      answer = { kind: 'cancelled' };
      expect(await invokeInputTypePicker({ field, value: expected, host, signal: new AbortController().signal }))
        .toEqual({ status: 'cancelled' });
    }
  });
  it('keeps native reference types on their existing selection controls instead of opening Usage fields', async () => {
    const host: InputTypePickerHostV1 = {
      resolveType: async () => { throw new Error('Native reference is not a plugin'); },
      resolveOptions: async () => { throw new Error('Native reference uses its inventory'); },
      openPicker: async () => { throw new Error('Native reference is not a plugin picker'); },
      openHostPicker: async () => { throw new Error('Native references must not open Usage fields'); },
    };
    for (const hostType of ['session', 'workspace'] as const) expect(await invokeInputTypePicker({
      field: { path: 'source', title: 'Source', widget: 'json', inputType: { hostType } },
      host, signal: new AbortController().signal,
    })).toEqual({ status: 'error', reasonCode: 'input_type_picker_unavailable' });
  });
  it('picks a host UsageQuery through the shared fields and schema without resolving a plugin', async () => {
    const field = { path: 'query', title: 'Usage', widget: 'json' as const, inputType: { hostType: 'usageQuery' as const } };
    let answer: unknown = { kind: 'completed', input: { period: { startMs: 100, endMs: 200 }, agents: ['codex', 'claude', 'codex'] } };
    const host: InputTypePickerHostV1 = {
      resolveType: async () => { throw new Error('Host input must not resolve a plugin'); },
      resolveOptions: async () => { throw new Error('Host input has no plugin Resource'); },
      openPicker: async () => { throw new Error('Host input has no plugin picker'); },
      openHostPicker: async request => {
        expect(request.reference).toEqual({ hostType: 'usageQuery' });
        expect(request.fields.map(field => field.path)).toEqual(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis', 'metric', 'breakdown']);
        return answer;
      },
    };
    const request = { field, host, signal: new AbortController().signal };
    expect(await invokeInputTypePicker(request)).toMatchObject({ status: 'selected', value: { agents: ['claude', 'codex'] } });
    answer = { kind: 'completed', input: { accountId: 'other' } };
    expect(await invokeInputTypePicker(request)).toMatchObject({ status: 'error', reasonCode: 'input_type_value_invalid' });
    answer = { kind: 'completed', input: { metric: 'tokens' } };
    expect(await invokeInputTypePicker({ ...request, field: { ...field,
      options: [{ value: { metric: 'cost' }, label: 'Cost' }],
    } })).toMatchObject({ status: 'error', reasonCode: 'input_type_option_invalid' });
  });
  it('selects only schema-admitted options, cancels without a value, and keeps invalid selections as field errors', async () => {
    let settlement: unknown = { kind: 'completed', input: 'one' };
    const host: InputTypePickerHostV1 = {
      resolveType: async () => type,
      resolveOptions: async () => [{ value: 'one', label: 'One' }, { value: 'disabled', label: 'Disabled', disabled: true }],
      openPicker: async request => {
        expect(request.picker).toEqual({ pluginId: identity.pluginId, localId: 'repository-picker' });
        return settlement;
      },
    };
    const request = { field, value: 'saved', host, signal: new AbortController().signal };
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'selected', value: 'one' });
    settlement = { kind: 'cancelled' };
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'cancelled' });
    for (const input of [42, 'other', 'disabled', { machineId: 'spoof' }]) {
      settlement = { kind: 'completed', input };
      expect(await invokeInputTypePicker(request)).toMatchObject({ status: 'error' });
    }
  });
  it('rejects removed/replaced types, denied options and a late cancelled mount without mutating the saved value', async () => {
    let current: ResolvedInputTypeV1 | null = type;
    let denied = false;
    let opened = 0;
    const abort = new AbortController();
    const host: InputTypePickerHostV1 = {
      resolveType: async () => current,
      resolveOptions: async () => denied ? { errorCode: 'credential_scope_denied' } : [{ value: 'one', label: 'One' }],
      openPicker: async () => { opened++; current = { ...type, occurrenceId: 'two' }; return { kind: 'completed', input: 'one' }; },
    };
    const request = { field, value: 'saved', host, signal: abort.signal };
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'error', reasonCode: 'input_type_retired' });
    current = null;
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'error', reasonCode: 'input_type_unavailable' });
    current = type; denied = true;
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'error', reasonCode: 'credential_scope_denied' });
    expect(opened).toBe(1);
    abort.abort();
    expect(await invokeInputTypePicker(request)).toEqual({ status: 'cancelled' });
    expect(request.value).toBe('saved');
    current = type; denied = false;
    const lateAbort = new AbortController();
    let complete: (value: unknown) => void = () => { throw new Error('Picker has not mounted'); };
    let started: () => void = () => {};
    const mounted = new Promise<void>(resolve => { started = resolve; });
    const late = invokeInputTypePicker({ ...request, signal: lateAbort.signal, host: { ...host,
      openPicker: () => new Promise(resolve => { complete = resolve; started(); }),
    } });
    await mounted;
    lateAbort.abort();
    complete({ kind: 'completed', input: 'one' });
    expect(await late).toEqual({ status: 'cancelled' });
    expect(request.value).toBe('saved');
  });
});
