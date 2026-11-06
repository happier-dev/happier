import { describe, expect, it } from 'vitest';
import { createInputTypePickerPort, resolveSemanticInputTypePickerReference } from './inputTypePickerPort';
import type { ResolvedInputTypeV1 } from '@happier-dev/protocol/inputs/runtime';

import type { PluginUiInputTypeProjection } from '@/sync/domains/plugins/ui/projection';

describe('host semantic picker discovery', () => {
  it('uses projection order among available matching pickers and keeps exact-reference consumers unchanged', async () => {
    const types = ['other', 'unavailable', 'first', 'second'].map((localId): PluginUiInputTypeProjection => ({
      id: `example.inputs/${localId}`, pluginId: 'example.inputs', pluginVersion: '1.0.0', occurrenceId: 'current',
      definition: { id: localId, title: localId, semantic: localId === 'other' ? 'repository' : 'scmPullRequestComparison',
        valueSchema: { type: 'string' }, picker: 'browse' },
    }));
    const entries = Object.fromEntries(types.map(type => [type.id, type]));
    const port = createInputTypePickerPort({
      readInputTypes: () => entries,
      resolveType: identity => {
        const entry = entries[`${identity.pluginId}/${identity.localId}`];
        return entry ? { identity, occurrenceId: 'current', definition: entry.definition } : null;
      },
      canOpenPicker: (_picker, type) => type.identity.localId !== 'unavailable',
      openPicker: async () => ({ kind: 'completed', input: 'selected' }),
    });
    const field = { path: 'comparison', title: 'Comparison' };
    expect(resolveSemanticInputTypePickerReference(port, 'scmPullRequestComparison', field))
      .toEqual({ pluginId: 'example.inputs', localId: 'first' });
    expect(resolveSemanticInputTypePickerReference(port, 'missing', field)).toBeNull();
    expect(resolveSemanticInputTypePickerReference(null, 'scmPullRequestComparison', field)).toBeNull();
    expect(resolveSemanticInputTypePickerReference({ describe: port.describe, pick: port.pick },
      'scmPullRequestComparison', field)).toBeNull();
    const exact = { ...field, inputType: { pluginId: 'example.inputs', localId: 'second' } };
    expect(port.describe(exact)).not.toBeNull();
    expect(await port.pick({ field: exact, value: undefined, signal: new AbortController().signal }))
      .toEqual({ status: 'selected', value: 'selected' });
    delete entries['example.inputs/first'];
    expect(resolveSemanticInputTypePickerReference(port, 'scmPullRequestComparison', field)).toEqual(exact.inputType);
  });
});

describe('native reference input picker projection', () => {
  it('keeps omitted picker-only inventory distinct from an explicitly empty field constraint', async () => {
    const identity = { pluginId: 'test.inputs', localId: 'repository' };
    const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'current', definition: {
      id: identity.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' }, picker: 'browse',
    } };
    const launches: unknown[] = [];
    const port = createInputTypePickerPort({
      resolveType: () => type,
      canOpenPicker: () => true,
      openPicker: async request => { launches.push(request.launchInput); return { kind: 'completed', input: 'repo' }; },
    });
    const field = { path: 'repository', title: 'Repository', inputType: identity };
    const signal = new AbortController().signal;
    expect(await port.pick({ field, value: undefined, options: [], signal })).toEqual({ status: 'selected', value: 'repo' });
    expect(launches[0]).toEqual({ inputType: identity, semantic: 'repository' });
    expect(await port.pick({ field: { ...field, options: [] }, value: undefined, options: [], signal })).toMatchObject({ status: 'error' });
    expect(await port.pick({ field: { ...field, optionsSourceId: 'repositories' }, value: undefined, options: [], signal })).toMatchObject({ status: 'error' });
    expect(await port.pick({ field, value: undefined, options: [{ value: 'other', label: 'Other' }], signal })).toMatchObject({ status: 'error' });
  });

  it('keeps a declared Resource inventory fail-closed when empty or unavailable', async () => {
    const identity = { pluginId: 'test.inputs', localId: 'repository' };
    const type: ResolvedInputTypeV1 = { identity, occurrenceId: 'current', definition: {
      id: identity.localId, title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' },
      picker: 'browse', options: { resource: 'repositories' },
    } };
    const port = createInputTypePickerPort({ resolveType: () => type, canOpenPicker: () => true,
      openPicker: async () => ({ kind: 'completed', input: 'repo' }),
    });
    const field = { path: 'repository', title: 'Repository', inputType: identity };
    const signal = new AbortController().signal;
    expect(await port.pick({ field, value: undefined, options: [], signal })).toMatchObject({ status: 'error' });
    expect(await port.pick({ field, value: undefined, signal })).toMatchObject({ status: 'error' });
    expect(await port.pick({ field, value: undefined, options: [{ value: 'repo', label: 'Repository' }], signal }))
      .toEqual({ status: 'selected', value: 'repo' });
  });

  it('edits and validates UsageQuery through the host form instead of plugin resolution', async () => {
    const port = createInputTypePickerPort({
      resolveType: () => { throw new Error('Host query must not resolve a plugin'); },
      canOpenPicker: () => { throw new Error('Host query has no plugin picker'); },
      openPicker: async () => { throw new Error('Host query has no plugin picker'); },
      openHostPicker: async () => ({ kind: 'completed', input: { agents: ['b', 'a', 'b'], metric: 'cost' } }),
    });
    const field = { path: 'query', title: 'Usage', widget: 'json' as const, inputType: { hostType: 'usageQuery' as const } };
    expect(port.describe(field)).not.toBeNull();
    // The Usage Period and Session choose in place from their type's source, also from an older saved hint.
    for (const projection of ['period', 'session'] as const) {
        expect(port.describe({ path: projection, title: projection, inputType: { hostType: 'usageQuery', field: projection } })).toBeNull();
    }
    expect(await port.pick({ field, value: undefined, signal: new AbortController().signal })).toMatchObject({
      status: 'selected', value: { agents: ['a', 'b'], metric: 'cost' },
    });
    expect(await port.pick({ field, value: undefined, options: [], signal: new AbortController().signal }))
      .toMatchObject({ status: 'selected', value: { agents: ['a', 'b'], metric: 'cost' } });
    expect(await port.pick({ field, value: undefined, options: [{ value: { metric: 'tokens' }, label: 'Tokens' }],
      signal: new AbortController().signal })).toMatchObject({ status: 'error' });
  });
  it('offers the shared executable participant picker and rejects a miswired selected value', async () => {
    const calls: unknown[] = [];
    const port = createInputTypePickerPort({
      resolveType: () => { throw new Error('A host participant must not resolve a plugin'); },
      canOpenPicker: () => { throw new Error('A host participant has no plugin renderer'); },
      openPicker: async () => { throw new Error('A host participant has no plugin renderer'); },
      canOpenHostPicker: reference => reference.hostType === 'agentParticipant',
      openHostPicker: async request => {
        calls.push(request.reference);
        return { kind: 'completed', input: { kind: 'session', session: { serverId: 'home-b', sessionId: 'reviewer' } } };
      },
    });
    const field = { path: 'reviewer', title: 'Reviewer', widget: 'select' as const,
      inputType: { hostType: 'agentParticipant' as const } };
    const signal = new AbortController().signal;
    expect(port.describe(field)).not.toBeNull();
    expect(await port.pick({ field, value: undefined, signal })).toEqual({ status: 'selected',
      value: { kind: 'session', session: { serverId: 'home-b', sessionId: 'reviewer' } },
    });
    expect(calls).toEqual([{ hostType: 'agentParticipant' }]);

    const listPort = createInputTypePickerPort({
      resolveType: () => null, canOpenPicker: () => false, openPicker: async () => ({ kind: 'cancelled' }),
      canOpenHostPicker: reference => reference.hostType === 'agentParticipant',
      openHostPicker: async (_request, requestedField) => requestedField?.widget === 'multiselect' ? ({ kind: 'completed', input: [
        { kind: 'session', session: { serverId: 'home-b', sessionId: 'reviewer' } },
        { kind: 'session', session: { serverId: 'home-a', sessionId: 'planner' } },
      ] }) : ({ kind: 'cancelled' }),
    });
    expect(await listPort.pick({ field: { ...field, widget: 'multiselect' }, value: undefined, signal })).toEqual({
      status: 'selected', value: [
        { kind: 'session', session: { serverId: 'home-b', sessionId: 'reviewer' } },
        { kind: 'session', session: { serverId: 'home-a', sessionId: 'planner' } },
      ],
    });

    const wrongHome = createInputTypePickerPort({
      resolveType: () => null, canOpenPicker: () => false, openPicker: async () => ({ kind: 'cancelled' }),
      canOpenHostPicker: reference => reference.hostType === 'agentParticipant',
      openHostPicker: async () => ({ kind: 'completed', input: { kind: 'session', session: { serverId: '', sessionId: 'reviewer' } } }),
    });
    expect(await wrongHome.pick({ field, value: undefined, signal })).toMatchObject({ status: 'error' });
    expect(createInputTypePickerPort({ resolveType: () => null, canOpenPicker: () => false,
      openPicker: async () => ({ kind: 'cancelled' }), openHostPicker: async () => ({ kind: 'cancelled' }),
    }).describe(field)).toBeNull();
  });
  it('offers no plugin picker for host Session and Workspace fields', () => {
    const port = createInputTypePickerPort({
      resolveType: () => { throw new Error('Host references must not resolve a plugin'); },
      canOpenPicker: () => { throw new Error('Host references have no plugin picker'); },
      openPicker: async () => { throw new Error('Host references have no plugin picker'); },
    });
    for (const hostType of ['session', 'workspace'] as const) expect(port.describe({
      path: 'source', title: 'Source', inputType: { hostType },
    })).toBeNull();
  });
});
