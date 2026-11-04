import { z } from 'zod/mini';
import { describe, expect, it } from 'vitest';

import {
  createDefaultPluginAccessScopeRegistry,
  createPluginAccessScopeRegistry,
} from './accessScopeRegistry';

describe('PluginAccessScopeRegistry', () => {
  it('retains admitted absolute Machine roots', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    for (const location of [{ root: 'machine', pathPrefix: '/srv/work' }, { root: 'machine', pathPrefix: 'C:\\work' }]) {
      const scope = { access: ['read'], locations: [location] };
      expect(registry.compare('filesystem', scope, scope)).toEqual({ relation: 'exact', reason: 'canonical_scope_equal' });
    }
  });

  it('ranks a contained canonical scope as narrower and everything else as changed', () => {
    const registry = createDefaultPluginAccessScopeRegistry();

    // Dropping a method leaves the candidate inside the previously granted
    // origin/method reach.
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
    )).toEqual({ relation: 'narrower', reason: 'canonical_scope_contained' });
    // `methods` is read as `undefined || includes(...)`, so omitting it reaches
    // every method and can never be contained in a declared method set.
    expect(registry.compare(
      'network',
      { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }] },
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET'],
      },
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });
    // Adding an origin reaches somewhere the grant did not.
    expect(registry.compare(
      'network',
      {
        targets: [
          { kind: 'fixedOrigin', origin: 'https://api.example.test' },
          { kind: 'fixedOrigin', origin: 'https://cdn.example.test' },
        ],
        methods: ['GET'],
      },
      {
        targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }],
        methods: ['GET'],
      },
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });
    // An independently selectable host resource ranks the same way.
    expect(registry.compare(
      'sessions',
      { access: ['read'], machineIds: ['machine-a'] },
      { access: ['read', 'write'], machineIds: ['machine-a', 'machine-b'] },
    )).toEqual({ relation: 'narrower', reason: 'canonical_scope_contained' });
    // `machineIds` is read as `!machineIds || includes(...)`, so dropping the
    // restriction widens the scope to every machine.
    expect(registry.compare(
      'sessions',
      { access: ['read'] },
      { access: ['read'], machineIds: ['machine-a'] },
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });
    // A structured location entry is ranked by set membership, so a deeper
    // path prefix under an already-granted root stays conservatively changed.
    expect(registry.compare(
      'filesystem',
      { locations: [{ root: 'workspace', pathPrefix: 'src' }], access: ['read'] },
      { locations: [{ root: 'workspace' }], access: ['read'] },
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });
    // An unregistered capability stays conservative rather than comparing.
    expect(registry.compare(
      'secrets',
      { secretIds: ['token'], access: ['read'] },
      { secretIds: ['token', 'webhook'], access: ['read', 'write'] },
    )).toEqual({ relation: 'changed', reason: 'unknown_capability' });
    expect(registry.compare('future.capability', {}, {})).toEqual({
      relation: 'changed',
      reason: 'unknown_capability',
    });
  });

  it('canonicalizes MCP server and discovery-source references as independent sets', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    const localDiscovery = 'local-discovery';
    const sharedDiscovery = { pluginId: 'other.plugin', localId: 'shared-discovery' } as const;
    const server = { pluginId: 'other.plugin', localId: 'shared-server' } as const;

    expect(registry.compare(
      'mcp',
      {
        serverRefs: [server, 'local-server'],
        discoverySourceRefs: [sharedDiscovery, localDiscovery],
        operations: ['discover', 'listTools'],
      },
      {
        serverRefs: ['local-server', server],
        discoverySourceRefs: [localDiscovery, sharedDiscovery],
        operations: ['listTools', 'discover'],
      },
    )).toMatchObject({ relation: 'exact' });
    expect(registry.compare(
      'mcp',
      {
        serverRefs: ['local-server'],
        discoverySourceRefs: [localDiscovery],
        operations: ['listTools', 'discover'],
      },
      {
        serverRefs: ['local-server'],
        discoverySourceRefs: [localDiscovery, sharedDiscovery],
        operations: ['listTools', 'discover'],
      },
    )).toEqual({ relation: 'narrower', reason: 'canonical_scope_contained' });
    expect(registry.compare(
      'mcp',
      {
        serverRefs: ['local-server', server],
        discoverySourceRefs: [localDiscovery],
        operations: ['listTools', 'discover'],
      },
      {
        serverRefs: ['local-server'],
        discoverySourceRefs: [localDiscovery],
        operations: ['listTools', 'discover'],
      },
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });

    const selection = registry.createSelection({
      pluginId: 'acme.plugin',
      accessId: 'mcp',
      capability: 'mcp',
      scope: {
        serverRefs: [server, 'local-server'],
        discoverySourceRefs: [sharedDiscovery, localDiscovery],
        operations: ['discover', 'listTools'],
      },
      selectedAtMs: 1,
    });
    expect(selection.normalizedScope).toEqual({
      serverRefs: ['local-server', server],
      discoverySourceRefs: ['local-discovery', sharedDiscovery],
      operations: ['discover', 'listTools'],
    });
  });

  it('canonicalizes and ranks Connected Account materialization authority', () => {
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
    )).toEqual({ relation: 'narrower', reason: 'canonical_scope_contained' });
    // Materialization is read as `?.includes(kind) !== true`, so omitting the
    // set materializes nothing: it is the narrowest value, never an implicit
    // superset of a declared one.
    expect(registry.compare(
      'connectedAccounts',
      base,
      { ...base, materializationKinds: ['environment'] },
    )).toEqual({ relation: 'narrower', reason: 'canonical_scope_contained' });
    expect(registry.compare(
      'connectedAccounts',
      { ...base, materializationKinds: ['environment'] },
      base,
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });

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

  it('accepts the exact optional Account-storage HostAccess scope', () => {
    const registry = createDefaultPluginAccessScopeRegistry();

    expect(registry.compare(
      'storage.account',
      { enabled: true },
      { enabled: true },
    )).toEqual({ relation: 'exact', reason: 'canonical_scope_equal' });
    expect(registry.createSelection({
      pluginId: 'acme.plugin',
      accessId: 'account-storage',
      capability: 'storage.account',
      scope: { enabled: true },
      selectedAtMs: 1,
    }).normalizedScope).toEqual({ enabled: true });
    expect(registry.createSelection({
      pluginId: 'acme.plugin',
      accessId: 'gateway',
      capability: 'network.client',
      scope: {
        targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
        transports: ['websocket'],
        privateNetwork: false,
      },
      selectedAtMs: 1,
    }).normalizedScope).toEqual({
      targets: [{ kind: 'fixedOrigin', origin: 'https://gateway.example.test' }],
      transports: ['websocket'],
      privateNetwork: false,
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
    )).toEqual({ relation: 'changed', reason: 'canonical_scope_differs' });
  });

  it('canonicalizes origin spelling and duplicate set entries before comparison', () => {
    const registry = createDefaultPluginAccessScopeRegistry();
    expect(registry.compare(
      'network',
      { targets: [{ kind: 'fixedOrigin', origin: 'https://API.example.test:443' }], methods: ['POST', 'GET', 'GET'] },
      { targets: [{ kind: 'fixedOrigin', origin: 'https://api.example.test' }], methods: ['GET', 'POST'], privateNetwork: false },
    )).toMatchObject({ relation: 'exact' });
  });

  it('rejects non-idempotent, mutating, or non-JSON canonicalizers', () => {
    const schema = z.strictObject({ value: z.string() });
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
    const schema = z.strictObject({ values: z.array(z.string()).check(z.minLength(1)) });
    const registration = {
      capability: 'stable',
      scopeSchema: schema,
      canonicalize: (scope: unknown) => scope,
    };
    const registry = createPluginAccessScopeRegistry([registration]);
    // A registration mutated after registration cannot retarget the registry:
    // this replacement would otherwise collapse every scope to one value.
    registration.canonicalize = () => ({ values: ['pinned'] });

    expect(registry.compare('stable', { values: ['a'] }, { values: ['b'] })).toEqual({
      relation: 'changed',
      reason: 'canonical_scope_differs',
    });
    expect(registry.compare('stable', { values: ['a'] }, { values: ['a'] })).toEqual({
      relation: 'exact',
      reason: 'canonical_scope_equal',
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

  it('uses locale-independent ordering for canonical Account-selection scope sets', () => {
    const selection = createDefaultPluginAccessScopeRegistry().createSelection({
      pluginId: 'acme.plugin', accessId: 'connected-accounts', capability: 'connectedAccounts',
      scope: {
        serviceRefs: ['github'],
        accountScopes: ['a', 'Z'],
        operations: ['use'],
      },
      selectedAtMs: 1,
    });

    expect(selection.normalizedScope).toEqual({
      serviceRefs: ['github'],
      accountScopes: ['Z', 'a'],
      operations: ['use'],
    });
  });

  it('rejects duplicate or non-canonical capability registrations', () => {
    const schema = z.strictObject({ value: z.string() });
    expect(() => createPluginAccessScopeRegistry([
      { capability: 'same', scopeSchema: schema, canonicalize: (scope) => scope },
      { capability: 'same', scopeSchema: schema, canonicalize: (scope) => scope },
    ])).toThrow(/duplicate/i);
    expect(() => createPluginAccessScopeRegistry([
      { capability: ' spaced ', scopeSchema: schema, canonicalize: (scope) => scope },
    ])).toThrow(/capability/i);
  });
});
