import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  createDefaultPluginAccessScopeRegistry,
  createPluginNetworkEffectScopeRegistry,
  createPluginAccessScopeRegistry,
} from './accessScopeRegistry';

describe('PluginAccessScopeRegistry', () => {
  it('does not expose ambient-power subset comparison through the optional-selection registry', () => {
    const registry = createDefaultPluginAccessScopeRegistry();

    expect(registry.compare(
      'network',
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET'],
      },
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET', 'POST'],
      },
    )).toEqual({
      relation: 'changed',
      reason: 'comparator_missing',
    });
    expect(registry.compare(
      'secrets',
      { secretIds: ['token'], access: ['read'] },
      { secretIds: ['token', 'webhook'], access: ['read', 'write'] },
    )).toMatchObject({ relation: 'narrower' });
  });

  it('returns exact, narrower, broader, invalid, and conservative changed decisions', () => {
    const registry = createDefaultPluginAccessScopeRegistry();

    expect(registry.compare('secrets', { secretIds: ['B', 'A'], access: ['read'] }, { secretIds: ['A', 'B'], access: ['read'] })).toMatchObject({
      relation: 'exact',
    });
    expect(registry.compare('secrets', { secretIds: ['A'], access: ['read'] }, { secretIds: ['A', 'B'], access: ['read'] })).toMatchObject({
      relation: 'narrower',
    });
    expect(registry.compare('secrets', { secretIds: ['A', 'B'], access: ['read'] }, { secretIds: ['A'], access: ['read'] })).toMatchObject({
      relation: 'broader',
    });
    expect(registry.compare('secrets', { secretIds: [], access: ['read'] }, { secretIds: ['A'], access: ['read'] })).toMatchObject({
      relation: 'invalid',
      reason: 'candidate_scope_invalid',
    });
    expect(registry.compare('future.capability', {}, {})).toEqual({
      relation: 'changed',
      reason: 'unknown_capability',
    });
    expect(registry.compare(
      'filesystem',
      { locations: [{ root: 'workspace', pathPrefix: 'src' }], access: ['read'] },
      { locations: [{ root: 'workspace' }], access: ['read'] },
    )).toMatchObject({ relation: 'changed', reason: 'comparator_missing' });
  });

  it('implements subset comparison only for independently selectable host resources', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    const narrowerCases = [
      ['secrets',
        { secretIds: ['token'], access: ['read'] },
        { secretIds: ['token', 'webhook'], access: ['read', 'write'] }],
      ['connectedAccounts',
        { serviceRefs: ['github'], accountScopes: ['read'], operations: ['use'], materializationKinds: ['environment'] },
        { serviceRefs: ['github', { pluginId: 'com.acme.accounts', localId: 'slack' }], accountScopes: ['read', 'write'], operations: ['select', 'use'], materializationKinds: ['files', 'environment'] }],
      ['sessions',
        { access: ['read'], machineIds: ['machine-a'], projectIds: ['project-a'] },
        { access: ['read', 'write'], machineIds: ['machine-a', 'machine-b'], projectIds: ['project-a'] }],
      ['mcp',
        { serverRefs: ['local-server'], operations: ['listTools'] },
        { serverRefs: ['local-server', { pluginId: 'other.plugin', localId: 'shared' }], operations: ['listTools', 'callTools'] }],
    ] as const;

    for (const [capability, candidate, previous] of narrowerCases) {
      expect(registry.compare(capability, candidate, previous), capability).toMatchObject({ relation: 'narrower' });
    }
  });

  it('canonicalizes and compares Connected Account materialization authority as an exact set', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    const base = {
      serviceRefs: ['github'],
      operations: ['use'],
    } as const;

    expect(registry.compare(
      'connectedAccounts',
      { ...base, materializationKinds: ['files', 'environment'] },
      { ...base, materializationKinds: ['environment', 'files'] },
    )).toMatchObject({ relation: 'exact' });
    expect(registry.compare(
      'connectedAccounts',
      { ...base, materializationKinds: ['environment'] },
      { ...base, materializationKinds: ['environment', 'files'] },
    )).toMatchObject({ relation: 'narrower' });
    expect(registry.compare(
      'connectedAccounts',
      base,
      { ...base, materializationKinds: ['environment'] },
    )).toMatchObject({ relation: 'narrower' });
    expect(registry.compare(
      'connectedAccounts',
      { ...base, materializationKinds: ['environment'] },
      base,
    )).toMatchObject({ relation: 'broader' });

    const selection = registry.createSelection({
      pluginId: 'acme.plugin',
      accessId: 'account',
      capability: 'connectedAccounts',
      scope: { ...base, materializationKinds: ['files', 'environment'] },
      selectedAtMs: 1,
    });
    expect(selection.normalizedScope).toEqual({
      serviceRefs: ['github'],
      operations: ['use'],
      materializationKinds: ['environment', 'files'],
    });
  });

  it('canonicalizes filesystem prefixes segment-wise and rejects root escape', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    expect(registry.compare(
      'filesystem',
      { locations: [{ root: 'workspace', pathPrefix: 'src/./plugin/' }], access: ['read'] },
      { locations: [{ root: 'workspace', pathPrefix: 'src/plugin' }], access: ['read'] },
    )).toMatchObject({ relation: 'exact' });
    expect(registry.compare(
      'filesystem',
      { locations: [{ root: 'workspace', pathPrefix: '../outside' }], access: ['read'] },
      { locations: [{ root: 'workspace' }], access: ['read'] },
    )).toMatchObject({ relation: 'invalid' });
    expect(registry.compare(
      'filesystem',
      { locations: [{ root: 'workspace', pathPrefix: 'src2' }], access: ['read'] },
      { locations: [{ root: 'workspace', pathPrefix: 'src' }], access: ['read'] },
    )).toMatchObject({ relation: 'changed', reason: 'comparator_missing' });
  });

  it('keeps concrete network-effect containment in a separate final-dispatch policy', () => {
    const registry = createPluginNetworkEffectScopeRegistry();

    expect(registry.compare(
      'network',
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET'],
      },
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET', 'POST'],
        privateNetwork: true,
      },
    )).toMatchObject({ relation: 'narrower' });
  });

  it('canonicalizes origin spelling and duplicate set entries before comparison', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    expect(registry.compare(
      'network',
      { targets: [{ kind: 'fixedOrigin', origin: 'https://API.example.test:443' }], methods: ['POST', 'GET', 'GET'] },
      { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }], methods: ['GET', 'POST'], privateNetwork: false },
    )).toMatchObject({ relation: 'exact' });
    expect(registry.compare(
      'network.intercept',
      { origins: ['https://API.example.test:443', 'https://api.example.test'] },
      { origins: ['https://api.example.test'] },
    )).toMatchObject({ relation: 'exact' });
  });

  it('fails closed when a capability comparator throws or cannot establish an order', () => {
    const schema = z.object({ value: z.string() }).strict();
    const throwing = createPluginAccessScopeRegistry([{
      capability: 'throws',
      scopeSchema: schema,
      canonicalize: (scope) => scope,
      isSubset: () => { throw new Error('boom'); },
    }]);
    const incomparable = createPluginAccessScopeRegistry([{
      capability: 'partial',
      scopeSchema: schema,
      canonicalize: (scope) => scope,
      isSubset: () => false,
    }]);

    expect(throwing.compare('throws', { value: 'next' }, { value: 'previous' })).toEqual({
      relation: 'changed',
      reason: 'comparator_error',
    });
    expect(incomparable.compare('partial', { value: 'next' }, { value: 'previous' })).toEqual({
      relation: 'changed',
      reason: 'incomparable',
    });
  });

  it('fails closed for non-boolean or input-mutating comparators', () => {
    const schema = z.object({ values: z.array(z.string()).min(1) }).strict();
    const nonBoolean = createPluginAccessScopeRegistry([{
      capability: 'non-boolean',
      scopeSchema: schema,
      canonicalize: (scope) => scope,
      isSubset: (() => 'truthy') as unknown as (candidate: unknown, previous: unknown) => boolean,
    }]);
    const mutating = createPluginAccessScopeRegistry([{
      capability: 'mutating',
      scopeSchema: schema,
      canonicalize: (scope) => scope,
      isSubset: (candidate) => {
        (candidate as { values: string[] }).values.pop();
        return true;
      },
    }]);

    expect(nonBoolean.compare('non-boolean', { values: ['a'] }, { values: ['a', 'b'] })).toEqual({
      relation: 'changed',
      reason: 'comparator_error',
    });
    expect(mutating.compare('mutating', { values: ['a'] }, { values: ['a', 'b'] })).toEqual({
      relation: 'changed',
      reason: 'comparator_error',
    });
  });

  it('fails closed for a non-deterministic comparator', () => {
    let next = false;
    const registry = createPluginAccessScopeRegistry([{
      capability: 'non-deterministic',
      scopeSchema: z.object({ value: z.string() }).strict(),
      canonicalize: (scope) => scope,
      isSubset: () => {
        next = !next;
        return next;
      },
    }]);

    expect(registry.compare('non-deterministic', { value: 'a' }, { value: 'b' })).toEqual({
      relation: 'changed',
      reason: 'comparator_error',
    });
  });

  it('rejects non-idempotent, mutating, or non-JSON canonicalizers', () => {
    const schema = z.object({ value: z.string() }).strict();
    const nonIdempotent = createPluginAccessScopeRegistry([{
      capability: 'non-idempotent',
      scopeSchema: schema,
      canonicalize: (scope) => ({ value: `${(scope as { value: string }).value}!` }),
    }]);
    const mutating = createPluginAccessScopeRegistry([{
      capability: 'mutating',
      scopeSchema: schema,
      canonicalize: (scope) => {
        (scope as { value: string }).value = 'changed';
        return scope;
      },
    }]);
    const nonJson = createPluginAccessScopeRegistry([{
      capability: 'non-json',
      scopeSchema: schema,
      canonicalize: () => new Date(0),
    }]);

    expect(nonIdempotent.compare('non-idempotent', { value: 'a' }, { value: 'b' })).toEqual({
      relation: 'invalid',
      reason: 'canonicalizer_error',
    });
    expect(() => mutating.createSelection({
      pluginId: 'acme.plugin', accessId: 'mutating', capability: 'mutating',
      scope: { value: 'a' }, selectedAtMs: 1,
    })).toThrow(/scope/i);
    expect(() => nonJson.createSelection({
      pluginId: 'acme.plugin', accessId: 'non-json', capability: 'non-json',
      scope: { value: 'a' }, selectedAtMs: 1,
    })).toThrow(/scope/i);
  });

  it('snapshots registrations and deeply freezes canonical selections', () => {
    const schema = z.object({ values: z.array(z.string()).min(1) }).strict();
    const registration = {
      capability: 'stable',
      scopeSchema: schema,
      canonicalize: (scope: unknown) => scope,
      isSubset: () => false,
    };
    const registry = createPluginAccessScopeRegistry([registration]);
    registration.isSubset = () => true;

    expect(registry.compare('stable', { values: ['a'] }, { values: ['b'] })).toEqual({
      relation: 'changed',
      reason: 'incomparable',
    });

    const selection = registry.createSelection({
      pluginId: 'acme.plugin', accessId: 'stable', capability: 'stable',
      scope: { values: ['a'] }, selectedAtMs: 1,
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.normalizedScope)).toBe(true);
    expect(Object.isFrozen(selection.normalizedScope.values)).toBe(true);
    expect(registry.validateSelection({ ...selection, pluginId: ' acme.plugin ' })).toBe(false);
    expect(registry.validateSelection({ ...selection, accessId: ' stable ' })).toBe(false);
    expect(registry.validateSelection({ ...selection, selectedAtMs: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  });

  it('uses locale-independent ordering for canonical scope sets', () => {
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: 'acme.plugin', accessId: 'secrets', capability: 'secrets',
      scope: { secretIds: ['a', 'Z'], access: ['read'] }, selectedAtMs: 1,
    });

    expect(selection.normalizedScope).toEqual({ secretIds: ['Z', 'a'], access: ['read'] });
  });

  it('rejects duplicate or non-canonical capability registrations', () => {
    const schema = z.object({ value: z.string() }).strict();
    expect(() => createPluginAccessScopeRegistry([
      { capability: 'same', scopeSchema: schema, canonicalize: (scope) => scope },
      { capability: 'same', scopeSchema: schema, canonicalize: (scope) => scope },
    ])).toThrow(/duplicate/i);
    expect(() => createPluginAccessScopeRegistry([
      { capability: ' spaced ', scopeSchema: schema, canonicalize: (scope) => scope },
    ])).toThrow(/capability/i);
  });
});
