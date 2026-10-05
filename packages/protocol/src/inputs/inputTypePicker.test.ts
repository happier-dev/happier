import { describe, expect, it } from 'vitest';
import { invokeInputTypePicker, type InputTypePickerHostV1 } from './inputTypePicker.js';
import type { ResolvedInputTypeV1 } from './inputTypeRuntime.js';

const identity = { pluginId: 'com.acme.inputs', localId: 'repository' };
const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'one', definition: {
  id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' },
  options: { resource: 'repositories' }, picker: 'repository-picker',
} };
const field = { path: 'repository', title: 'Repository', widget: 'select' as const, inputType: identity };

describe('host-admitted input type picker', () => {
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
