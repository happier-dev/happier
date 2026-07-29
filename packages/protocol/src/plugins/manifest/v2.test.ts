import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PluginManifestV2Schema,
  type ParsedPluginManifestV2,
  type PluginManifestV2,
} from '../../index.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.0.0',
    displayName: 'Fixture',
    engines: { happier: '^0.2.0' },
    runtime: { apiVersion: 1 },
    ...overrides,
  };
}

describe('plugin manifest v2 root contract', () => {
  it('parses the current entrypoint and activation vocabulary with canonical defaults', () => {
    const authoredManifest = {
      schemaVersion: 2,
      id: 'com.acme.fixture',
      version: '1.0.0',
      displayName: 'Fixture',
      engines: { happier: '^0.2.0' },
      runtime: { apiVersion: 1 },
      entrypoints: {
        daemon: './dist/plugin.js',
        development: './src/plugin.ts',
      },
      activation: {
        events: [{ kind: 'startup' }],
      },
    } satisfies PluginManifestV2;

    const parsed = PluginManifestV2Schema.parse(authoredManifest);

    expect(parsed).toMatchObject({
      entrypoints: authoredManifest.entrypoints,
      activation: authoredManifest.activation,
      hostAccess: { required: [], optional: [] },
    });
    expect(parsed.contributes).toBeDefined();
    expectTypeOf(parsed).toEqualTypeOf<ParsedPluginManifestV2>();
  });

  it('accepts globally namespaced plugin ids and rejects bare or non-canonical ids', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'happier.agent.codex' })).success).toBe(true);
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'codex' })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({ id: 'Happier.Agent.Codex' })).success).toBe(false);
  });

  it.each([
    ['uses', { uses: ['agents'] }],
    ['declares', { declares: { capabilities: [] } }],
    ['permissions', { permissions: { required: [] } }],
    ['source', { source: { kind: 'path', path: '/tmp/plugin' } }],
    ['activationEvents', { activationEvents: ['startup'] }],
    ['marketplace', { marketplace: { featured: true } }],
    ['targets', { targets: { daemon: './dist/plugin.js' } }],
    ['capabilities', { capabilities: [] }],
    ['contributions', { contributions: [] }],
  ])('rejects the retired root owner %s', (_name, retiredOwner) => {
    expect(PluginManifestV2Schema.safeParse(manifest(retiredOwner)).success).toBe(false);
  });

  it.each([
    ['main', { main: './dist/plugin.js' }],
    ['dev', { dev: './src/plugin.ts' }],
  ])('rejects the retired entrypoint %s', (_name, entrypoints) => {
    expect(PluginManifestV2Schema.safeParse(manifest({ entrypoints })).success).toBe(false);
  });

  it('rejects malformed current activation events and unknown root fields', () => {
    expect(PluginManifestV2Schema.safeParse(manifest({
      activation: { events: ['startup'] },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      futureBehavior: true,
    })).success).toBe(false);
  });

  it('accepts catalog-backed hook registrations and rejects unknown hook ids', () => {
    const hook = {
      id: 'before-agent-request',
      on: 'agent.request.before',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
    };

    const parsed = PluginManifestV2Schema.parse(manifest({
      hostAccess: {
        required: [{
          id: 'account',
          capability: 'connectedAccounts',
          reason: 'Use a selected account',
          scope: {
            serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
            operations: ['use'],
          },
        }],
        optional: [],
      },
      contributes: { hooks: [{ ...hook, hostAccess: ['account'] }] },
    }));
    expect(parsed.contributes.hooks).toEqual([{ ...hook, hostAccess: ['account'], hookApiVersion: 1 }]);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        hooks: [{ ...hook, on: 'acme.custom.before' }],
      },
    })).success).toBe(false);
  });

  it('requires explicit use authority for bounded Connected Account materialization kinds', () => {
    const hostAccessRequest = {
      id: 'account',
      capability: 'connectedAccounts' as const,
      reason: 'Use a selected account',
      scope: {
        serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
        operations: ['use' as const],
        materializationKinds: ['files' as const, 'environment' as const],
      },
    };

    expect(PluginManifestV2Schema.parse(manifest({
      hostAccess: { required: [hostAccessRequest], optional: [] },
    })).hostAccess.required[0]).toEqual(hostAccessRequest);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            operations: ['select'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: [],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: ['files', 'files'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: {
        required: [{
          ...hostAccessRequest,
          scope: {
            ...hostAccessRequest.scope,
            materializationKinds: ['rawSecret'],
          },
        }],
        optional: [],
      },
    })).success).toBe(false);

    const inspectionOnly = {
      ...hostAccessRequest,
      scope: {
        serviceRefs: hostAccessRequest.scope.serviceRefs,
        operations: ['use' as const],
      },
    };
    expect(PluginManifestV2Schema.safeParse(manifest({
      hostAccess: { required: [inspectionOnly], optional: [] },
    })).success).toBe(true);
  });

  it('accepts current request interceptors and rejects retired shapes or unsafe origins', () => {
    const interceptor = {
      id: 'api-egress',
      origins: ['https://api.example.test'],
      methods: ['GET'],
      priority: 20,
    };

    const parsed = PluginManifestV2Schema.parse(manifest({
      contributes: { requestInterceptors: [interceptor] },
    }));
    expect(parsed.contributes.requestInterceptors).toEqual([interceptor]);

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        requestInterceptors: [{
          id: 'retired-shape',
          order: 20,
          targets: [{ scope: 'plugin-fetch' }],
        }],
      },
    })).success).toBe(false);
    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: {
        requestInterceptors: [{
          ...interceptor,
          origins: ['https://api.example.test/path'],
        }],
      },
    })).success).toBe(false);
  });

  it('rejects provider-shaped keys on a current Agent contribution', () => {
    const agent = {
      id: 'fixture-agent',
      title: 'Fixture Agent',
      runtime: { kind: 'custom' },
      primary: 'sessions',
      capabilities: {
        sessions: {
          open: ['create'],
          delivery: ['newTurn'],
          cancel: true,
        },
      },
    };

    expect(PluginManifestV2Schema.safeParse(manifest({
      contributes: { agents: [agent] },
    })).success).toBe(true);

    for (const providerKey of ['agentId', 'providerAgentId', 'providerCliRuntime']) {
      expect(PluginManifestV2Schema.safeParse(manifest({
        contributes: {
          agents: [{ ...agent, [providerKey]: 'provider-owned' }],
        },
      })).success, providerKey).toBe(false);
    }
  });
});
