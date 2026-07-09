import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import * as protocol from '../../index.js';
import type { ParsedPluginManifestV2, PluginManifestV2 } from '../../index.js';

function readSchemaExport(name: string): z.ZodTypeAny | undefined {
  const value = (protocol as Record<string, unknown>)[name];
  return value && typeof value === 'object' && 'safeParse' in value
    ? value as z.ZodTypeAny
    : undefined;
}

function agentOwnerContributions(agentId: string) {
  return {
    agents: [
      {
        kindVersion: 1,
        id: agentId,
        display: { name: `${agentId} Agent` },
        ownedBackendIds: [`${agentId}.backend`],
        runtime: { kind: 'custom' },
      },
    ],
  } as const;
}

function managedDependencyContribution(id: string) {
  return {
    id,
    key: id,
    kind: 'dep',
    version: '1',
    capabilityId: `dep.${id}`,
    display: { name: id },
    description: `${id} dependency`,
    source: { kind: 'manual_only', setupUrl: `https://example.com/${id}` },
    binary: { commands: [id], systemFirst: true },
    defaultPolicy: { autoInstallWhenNeeded: false, autoUpdateMode: 'notify' },
    consent: { install: 'required', update: 'required' },
  } as const;
}

describe('plugin manifest v2 contracts', () => {
  it('parses the v1-final agent manifest vocabulary without legacy contribution families', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.agent-runtime',
      version: '1.2.3',
      displayName: 'Acme Agent Runtime',
      engines: { happier: '^1.0.0' },
      uses: ['agents', 'actions', 'tools', 'hooks', 'managedDependencies'],
      entrypoints: {
        main: './dist/activate.js',
        dev: './src/activate.ts',
      },
      permissions: {
        required: [{ capability: 'filesystem.read' }],
        optional: [{ capability: 'network' }],
      },
      activationEvents: ['onAgent:acme.agent'],
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            ownedBackendIds: [],
            runtime: { kind: 'custom' },
            xFutureAgentContribution: { preserved: true },
          },
        ],
        agentSettings: [
          {
            id: 'acme.agent.settings',
            kind: 'agentSettings.v1',
            agentId: 'acme.agent',
            fields: [],
          },
        ],
        actions: [
          {
            id: 'acme.agent.refresh',
            title: 'Refresh Acme',
            scopes: ['agent'],
            surfaces: ['agent'],
            placement: 'primary',
            dangerLevel: 'safe',
            handler: { target: 'plugin', exportName: 'refreshAcme' },
            xFutureActionContribution: { preserved: true },
          },
        ],
        tools: [
          {
            id: 'acme.agent.inspect',
            name: 'inspect_acme',
            title: 'Inspect Acme',
            surfaces: ['agent', 'mcp'],
            handler: { target: 'plugin', exportName: 'inspectAcme' },
          },
        ],
        managedDependencies: [
          managedDependencyContribution('acme-cli'),
        ],
        hooks: [
          {
            id: 'agent.resolvePrerequisites',
            category: 'decision',
            scope: 'agent',
            executionKind: 'decide',
            filters: { agentId: 'acme.agent' },
            handler: { target: 'plugin', exportName: 'resolvePrerequisites' },
            xFutureHookContribution: { preserved: true },
          },
        ],
      },
      xFutureManifestRoot: { preserved: true },
    });

    expect(parsed.uses).toEqual(['agents', 'actions', 'tools', 'hooks', 'managedDependencies']);
    expect(parsed.entrypoints).toMatchObject({ main: './dist/activate.js', dev: './src/activate.ts' });
    expect(parsed.permissions.required.map((permission) => permission.capability)).toEqual(['filesystem.read']);
    expect(parsed.permissions.optional.map((permission) => permission.capability)).toEqual(['network']);
    expect(parsed.activationEvents).toEqual(['onAgent:acme.agent']);
    expect(parsed.contributes.agents[0]).toMatchObject({ id: 'acme.agent' });
    expect('agentId' in parsed.contributes.agents[0]).toBe(false);
    expect(parsed.contributes.agentSettings[0]).toMatchObject({
      kind: 'agentSettings.v1',
      agentId: 'acme.agent',
    });
    expect(parsed.contributes.tools[0]?.surfaces).toEqual(['agent', 'mcp']);
    expect(parsed.contributes.managedDependencies[0]?.id).toBe('acme-cli');
    expect((parsed as Readonly<Record<string, unknown>>).xFutureManifestRoot).toEqual({ preserved: true });
    expect(parsed.contributes.agents[0] as Readonly<Record<string, unknown>>)
      .toMatchObject({ xFutureAgentContribution: { preserved: true } });
    expect(parsed.contributes.actions[0] as Readonly<Record<string, unknown>>)
      .toMatchObject({ xFutureActionContribution: { preserved: true } });
    expect(parsed.contributes.hooks[0] as Readonly<Record<string, unknown>>)
      .toMatchObject({ xFutureHookContribution: { preserved: true } });
    expect('backends' in parsed.contributes).toBe(false);
    expect(`provider${'Settings'}` in parsed.contributes).toBe(false);
    expect(`install${'ables'}` in parsed.contributes).toBe(false);

    expect(manifestSchema!.safeParse({
      ...parsed,
      contributes: {
        ...parsed.contributes,
        agents: [
          {
            ...parsed.contributes.agents[0],
            agentId: 'acme.agent',
          },
        ],
      },
    }).success).toBe(false);
  });

  it('requires globally namespaced plugin owner ids while accepting first-party owner ids', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      version: '1.0.0',
      displayName: 'Owner Id Test',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      contributes: {},
      permissions: { required: [] },
    };
    const firstPartyAgentPluginId = 'happier.agent.codex';
    const firstPartyScmPluginId = 'happier.scm.hosting.github';

    expect(manifestSchema!.parse({
      ...baseManifest,
      id: firstPartyAgentPluginId,
    }).id).toBe(firstPartyAgentPluginId);
    expect(manifestSchema!.parse({
      ...baseManifest,
      id: firstPartyScmPluginId,
    }).id).toBe(firstPartyScmPluginId);

    for (const id of ['codex', 'claude', 'opencode', 'scm-github', 'Acme.Plugin']) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        id,
      }).success, id).toBe(false);
    }
  });

  it('accepts nested contributes and capabilities while rejecting stale flat keys', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['actions', 'commands'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        actions: [
          {
            id: 'acme.plugin.refresh',
            title: 'Refresh Acme',
            scopes: ['settings'],
            surfaces: ['cli'],
            placement: 'primary',
            dangerLevel: 'safe',
            handler: {
              target: 'daemon',
              exportName: 'refreshAcme',
            },
          },
        ],
        commands: [
          {
            id: 'acme.plugin.reload',
            command: 'acme reload',
            handler: {
              target: 'daemon',
              exportName: 'reloadAcme',
            },
          },
        ],
      },
      permissions: { required: [
          {
            capability: 'network',
            reason: 'Calls the plugin service API',
          },
        ] },
      declares: {
        capabilities: [
          {
            capability: 'actions.execute',
            reason: 'Defines executable action metadata',
          },
        ],
      },
    });

    expect(parsed.contributes.actions).toHaveLength(1);
    expect(parsed.contributes.commands).toHaveLength(1);
    expect(parsed.permissions.required).toHaveLength(1);
    expect(parsed.declares.capabilities.map((capability) => capability.capability)).toEqual(['actions.execute']);

    const staleFlatManifest = {
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: { happier: '^1.0.0' },
      uses: ['actions'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {},
      permissions: {},
    } as Record<string, unknown>;
    staleFlatManifest.contributions = [];
    expect(manifestSchema!.safeParse(staleFlatManifest).success).toBe(false);

    const stalePermissionManifest = {
      schemaVersion: 2,
      id: 'acme.plugin',
      version: '1.0.0',
      displayName: 'Acme Plugin',
      engines: { happier: '^1.0.0' },
      uses: ['actions'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {},
      permissions: {},
    } as Record<string, unknown>;
    stalePermissionManifest.permissions = [];
    expect(manifestSchema!.safeParse(stalePermissionManifest).success).toBe(false);
  });

  it('rejects provider-shaped keys in plugin agent contributions', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.agent-vocabulary',
      version: '1.0.0',
      displayName: 'Acme Agent Vocabulary',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
    };

    for (const legacyKey of ['agentId', 'providerAgentId', 'providerCliRuntime']) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          agents: [
            {
              id: 'acme.agent',
              display: { name: 'Acme Agent' },
              ownedBackendIds: [],
              runtime: { kind: 'custom' },
              [legacyKey]: legacyKey === 'providerAgentId'
                ? 'claude'
                : legacyKey === 'agentId'
                  ? 'acme.agent'
                : {
                  id: 'acme.agent',
                  title: 'Acme Agent',
                  binaryName: 'acme-agent',
                  sourcePreferenceDefault: 'system-first',
                  managedInstall: null,
                  manualInstallKind: 'none',
                  manualInstallRecipes: null,
                  acceptsJavaScriptFileOverride: false,
                },
            },
          ],
        },
      }).success, legacyKey).toBe(false);
    }
  });

  it('accepts final hierarchical permission names and optional runtime grants while rejecting stale event names', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.permissions',
      version: '1.0.0',
      displayName: 'Acme Permissions',
      engines: { happier: '^1.0.0' },
      uses: ['terminalHost'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {},
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      permissions: {
        required: [
          { capability: 'events.runtime.subscribe' },
          { capability: 'events.lifecycle.subscribe' },
          { capability: 'events.session.subscribe' },
          { capability: 'events.plugin.subscribe', scope: 'acme.observed' },
          { capability: 'network' },
          { capability: 'network.intercept' },
          { capability: 'reviews.comments.write.direct' },
          { capability: 'terminal.host.control' },
        ],
        optional: [
          { capability: 'process.spawn', scope: '/usr/bin/git' },
          { capability: 'filesystem.write', scope: 'artifacts' },
        ],
      },
      declares: {
        capabilities: [
          { capability: 'secrets.read', reason: 'Read user-selected credentials at runtime' },
          { capability: 'storage.synced' },
        ],
      },
    });

    expect(parsed.permissions.required.map((permission) => permission.capability)).toEqual([
      'events.runtime.subscribe',
      'events.lifecycle.subscribe',
      'events.session.subscribe',
      'events.plugin.subscribe',
      'network',
      'network.intercept',
      'reviews.comments.write.direct',
      'terminal.host.control',
    ]);
    expect(parsed.permissions.optional.map((permission) => permission.capability)).toEqual([
      'process.spawn',
      'filesystem.write',
    ]);
    expect(parsed.declares.capabilities.map((capability) => capability.capability)).toEqual([
      'secrets.read',
      'storage.synced',
    ]);

    for (const staleCapability of [
      'events.subscribe',
      'runtimeEvents.subscribe',
      'runtime.subscribe',
      'lifecycle.subscribe',
      'session.subscribe',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        permissions: { required: [{ capability: staleCapability }] },
      }).success, staleCapability).toBe(false);
    }
  });

  it('classifies enforced permissions separately from declarative plugin capabilities', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.permission-classification',
      version: '1.0.0',
      displayName: 'Acme Permission Classification',
      engines: { happier: '^1.0.0' },
      uses: ['actions', 'reload'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {},
    };

    expect(manifestSchema!.safeParse({
      ...baseManifest,
      permissions: {
        required: [
          { capability: 'storage.local', reason: 'Use plugin-local storage metadata' },
        ],
      },
    }).success).toBe(false);

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      declares: {
        capabilities: [
          { capability: 'actions.execute', reason: 'Defines executable action metadata' },
          { capability: 'storage.local', reason: 'Uses plugin-local storage' },
          { capability: 'reload', reason: 'Participates in plugin reload flows' },
        ],
      },
      permissions: {
        required: [
          { capability: 'network', scope: 'https://api.example.test' },
        ],
        optional: [
          { capability: 'process.spawn', scope: '/usr/bin/git' },
        ],
      },
    });

    expect(parsed.permissions.required.map((permission) => permission.capability)).toEqual(['network']);
    expect(parsed.permissions.optional.map((permission) => permission.capability)).toEqual(['process.spawn']);
    expect(parsed.declares.capabilities.map((capability) => capability.capability)).toEqual([
      'actions.execute',
      'storage.local',
      'reload',
    ]);
  });

  it('accepts system-tool contributions with schema defaults and rejects unknown tool fields', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.system-tools',
      version: '1.0.0',
      displayName: 'Acme System Tools',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        systemTools: [
          {
            toolId: 'acme.audit',
            displayName: 'Acme Audit',
            lookupNames: ['acme-audit'],
            source: 'system',
          },
        ],
      },
    });

    expect(parsed.contributes.systemTools).toEqual([
      {
        toolId: 'acme.audit',
        displayName: 'Acme Audit',
        lookupNames: ['acme-audit'],
        defaultArgs: [],
        source: 'system',
      },
    ]);
    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        systemTools: [
          {
            toolId: 'acme.audit',
            displayName: 'Acme Audit',
            command: 'acme-audit',
          },
        ],
      },
    }).success).toBe(false);
  });

  it('accepts agent tool prompt snippets and guidelines on tool contributions', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.tool-prompts',
      version: '1.0.0',
      displayName: 'Acme Tool Prompts',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
      contributes: {
        tools: [
          {
            id: 'acme.audit',
            name: 'acme_audit',
            title: 'Acme Audit',
            description: 'Audit the workspace',
            surfaces: ['agent'],
            handler: {
              target: 'plugin',
              exportName: 'audit',
            },
            promptSnippet: 'Use acme_audit when the user asks for an Acme compliance scan.',
            promptGuidelines: [
              'Do not call acme_audit for ordinary file search.',
              'Summarize only stable findings returned by the tool.',
            ],
          },
        ],
      },
    });

    expect(parsed.contributes.tools[0]).toMatchObject({
      promptSnippet: 'Use acme_audit when the user asks for an Acme compliance scan.',
      promptGuidelines: [
        'Do not call acme_audit for ordinary file search.',
        'Summarize only stable findings returned by the tool.',
      ],
    });
  });

  it('types optional runtime permission grants as authoring-optional and parse-defaulted', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const authoredManifest = {
      schemaVersion: 2,
      id: 'acme.optional-permissions',
      version: '1.0.0',
      displayName: 'Acme Optional Permissions',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
      contributes: {},
    } satisfies PluginManifestV2;

    const parsed = manifestSchema!.parse(authoredManifest) as ParsedPluginManifestV2;

    expect(parsed.permissions.optional).toEqual([]);
    expectTypeOf(parsed.permissions.optional).toEqualTypeOf<ParsedPluginManifestV2['permissions']['optional']>();
  });

  it('accepts manifest-declared events with local slash ids and rejects stale event ids', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.events',
      version: '1.0.0',
      displayName: 'Acme Events',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
    };

    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        events: [
          {
            id: 'checkpoint/created',
            payloadSchema: {
              type: 'object',
              properties: {
                checkpointId: { type: 'string' },
              },
              required: ['checkpointId'],
            },
            description: 'Emitted when Acme creates a checkpoint',
          },
        ],
      },
    });

    expect(parsed.contributes.events).toEqual([
      {
        id: 'checkpoint/created',
        payloadSchema: {
          type: 'object',
          properties: {
            checkpointId: { type: 'string' },
          },
          required: ['checkpointId'],
        },
        description: 'Emitted when Acme creates a checkpoint',
        deprecated: false,
      },
    ]);

    for (const staleEventId of [
      'checkpoint.created',
      'acme.events.checkpoint-created',
      'acme.events/checkpoint-created',
      '@happier/runtime/reload',
      '/checkpoint',
      'checkpoint/',
      'checkpoint//created',
      'checkpoint/Created',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          events: [{ id: staleEventId }],
        },
      }).success, staleEventId).toBe(false);
    }
  });

  it('accepts only catalog-backed public hook ids in manifest declarations', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.hooks',
      version: '1.0.0',
      displayName: 'Acme Hooks',
      engines: { happier: '^1.0.0' },
      uses: ['hooks'],
      entrypoints: { main: './dist/activate.js' },
    };
    const agentResponseHook = {
      id: 'agent.response.after',
      category: 'lifecycle',
      scope: 'agent',
      executionKind: 'observe',
      handler: { target: 'plugin', exportName: 'onAgentResponse' },
    };
    const parsed = manifestSchema!.parse({
      ...baseManifest,
      contributes: {
        hooks: [
          agentResponseHook,
          {
            id: 'subagent.started',
            category: 'lifecycle',
            scope: 'session',
            executionKind: 'observe',
            handler: { target: 'plugin', exportName: 'onSubagentStarted' },
          },
        ],
      },
    });

    expect(parsed.contributes.hooks.map((hook) => hook.id)).toEqual([
      'agent.response.after',
      'subagent.started',
    ]);

    for (const id of [
      'connectedServices.materialization.githubScmHostingToken',
      'connectedServices.materialization.bitbucketScmHostingBasicAuth',
      'provider.request.before',
      'sidechain.start',
      'acme.hooks.custom',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          hooks: [{ ...agentResponseHook, id }],
        },
      }).success, id).toBe(false);
    }
  });

  it('accepts manifest-declared request interceptors with order and plugin-fetch targets only', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.policy',
      version: '1.0.0',
      displayName: 'Acme Policy',
      engines: {
        happier: '^1.0.0',
      },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        requestInterceptors: [
          {
            id: 'acme.policy.egress',
            order: 20,
            targets: [
              {
                scope: 'plugin-fetch',
                urlOrigins: ['https://api.example.test'],
              },
            ],
          },
        ],
      },
      permissions: { required: [
          {
            capability: 'network.intercept',
            reason: 'Mediate plugin and Happier server requests',
          },
        ] },
    });

    expect(parsed.contributes.requestInterceptors).toEqual([
      {
        id: 'acme.policy.egress',
        order: 20,
        targets: [
          {
            scope: 'plugin-fetch',
            urlOrigins: ['https://api.example.test'],
          },
        ],
      },
    ]);
    expect(parsed.permissions.required.map((entry: { capability: string }) => entry.capability))
      .toContain('network.intercept');
  });

  it('rejects stale request interceptor priority and unknown target scopes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.policy',
      version: '1.0.0',
      displayName: 'Acme Policy',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [{ capability: 'network.intercept' }] },
    };

    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        requestInterceptors: [
          {
            id: 'acme.policy.priority',
            priority: 10,
            targets: [{ scope: 'plugin-fetch' }],
          },
        ],
      },
    }).success).toBe(false);

    for (const invalidScope of [
      'marketplace',
      'provider-auth',
      'backend-runtime',
      'happier-server',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          requestInterceptors: [
            {
              id: 'acme.policy.unknown',
              order: 10,
              targets: [{ scope: invalidScope }],
            },
          ],
        },
      }).success, invalidScope).toBe(false);
    }

    for (const invalidUrlOrigin of [
      'api.example.test',
      'https://api.example.test/path',
      'https://api.example.test?token=value',
      'ftp://api.example.test',
    ]) {
      expect(manifestSchema!.safeParse({
        ...baseManifest,
        contributes: {
          requestInterceptors: [
            {
              id: 'acme.policy.invalid-origin',
              order: 10,
              targets: [{ scope: 'plugin-fetch', urlOrigins: [invalidUrlOrigin] }],
            },
          ],
        },
      }).success, invalidUrlOrigin).toBe(false);
    }
  });

  it('normalizes agent execution-run capability support to the nested contract', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const defaultSupported = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.agent-default',
      version: '1.0.0',
      displayName: 'Acme Agent Default',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            runtime: { kind: 'custom' },
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(defaultSupported.contributes.agents[0]?.capabilities).toEqual({
      executionRun: { supported: true },
      session: {
        media: {
          acceptsImageInput: { supported: false },
          emitsSessionMedia: { supported: false },
          nativeImageGeneration: { supported: false },
        },
        contextCompaction: {
          events: { supported: false },
          manualTrigger: { supported: false },
          transcriptInference: { supported: false },
        },
      },
    });

    const explicitOptOut = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.agent-opt-out',
      version: '1.0.0',
      displayName: 'Acme Agent Opt Out',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            runtime: { kind: 'custom' },
            capabilities: {
              executionRun: { supported: false },
            },
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(explicitOptOut.contributes.agents[0]?.capabilities).toEqual({
      executionRun: { supported: false },
      session: {
        media: {
          acceptsImageInput: { supported: false },
          emitsSessionMedia: { supported: false },
          nativeImageGeneration: { supported: false },
        },
        contextCompaction: {
          events: { supported: false },
          manualTrigger: { supported: false },
          transcriptInference: { supported: false },
        },
      },
    });

    expect(() => manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.agent-invalid-recovery',
      version: '1.0.0',
      displayName: 'Acme Agent Invalid Recovery',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        agents: [
          {
            kindVersion: 1,
            id: 'acme.agent',
            display: { name: 'Acme Agent' },
            runtime: { kind: 'custom' },
            capabilities: {
              executionRun: {
                supported: true,
                structuredOutputRecovery: { plan: 'vendor-special' },
              },
            },
          },
        ],
      },
      permissions: { required: [] },
    })).toThrow();
  });

  it('accepts notification contribution families while rejecting stale activity providers', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.notifications',
      version: '1.0.0',
      displayName: 'Acme Notifications',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['notifications'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        notifications: [
          {
            id: 'acme.notifications.reviewReady',
            kind: 'activity',
            title: 'Review ready',
            eventIds: ['ready'],
            defaultChannelIds: ['builtin:expo_push'],
          },
          {
            id: 'acme.notifications.approvalNeeded',
            kind: 'approval',
            title: 'Approval needed',
            eventIds: ['permission_request'],
          },
        ],
        notificationChannels: [
          {
            id: 'acme.notifications.webhook',
            kind: 'webhook',
            title: 'Acme webhook',
          },
        ],
      },
    });

    expect(parsed.uses).toContain('notifications');
    expect(parsed.contributes.notifications.map((definition: { id: string }) => definition.id)).toEqual([
      'acme.notifications.reviewReady',
      'acme.notifications.approvalNeeded',
    ]);
    expect(parsed.contributes.notificationChannels.map((definition: { id: string }) => definition.id)).toEqual([
      'acme.notifications.webhook',
    ]);

    const legacyActivityProviderFamily = `activity${'Providers'}`;
    const staleActivityProviderManifest = {
      schemaVersion: 2,
      id: 'acme.notifications',
      version: '1.0.0',
      displayName: 'Acme Notifications',
      engines: { happier: '^1.0.0' },
      uses: ['notifications'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        [legacyActivityProviderFamily]: [
          {
            id: 'acme.activity',
          },
        ],
      },
      permissions: {},
    };

    expect(manifestSchema!.safeParse(staleActivityProviderManifest).success).toBe(false);
  });

  it('accepts non-agent SCM hosting-provider contributions in nested contributes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.scm',
      version: '1.0.0',
      displayName: 'Acme SCM',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['scmHostingProviders'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        scmHostingProviders: [
          {
            id: 'acme.scm.github',
            kind: 'github',
            displayName: 'Acme GitHub',
            baseUrl: 'https://github.example.com',
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.scmHostingProviders).toEqual([
      expect.objectContaining({
        id: 'acme.scm.github',
        kind: 'github',
        urlSafety: expect.objectContaining({
          allowedSchemes: ['https:'],
        }),
      }),
    ]);
    expect(parsed.contributes.agents).toEqual([]);
    expect('backends' in parsed.contributes).toBe(false);
  });

  it('accepts connected-account descriptor contributions while rejecting secret-bearing descriptor metadata', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.auth',
      version: '1.0.0',
      displayName: 'Acme Auth',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['connectedAccountDescriptors'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        connectedAccountDescriptors: [
          {
            id: 'gitlab',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'plugins.acme.auth.gitlab.name',
            aliases: ['gitlab'],
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [
              {
                targetId: 'gitlab',
                mode: 'token',
                credentialKind: 'token',
                default: true,
                tokenKind: 'personal-access-token',
              },
            ],
            tokenSetup: {
              tokenKind: 'personal-access-token',
              promptLabelKey: 'plugins.acme.auth.gitlab.tokenPrompt',
              missingValueErrorKey: 'plugins.acme.auth.gitlab.missingToken',
            },
            ui: {
              connectCommand: 'happier connect gitlab --token',
              oauthAddActionModes: [],
            },
            materialization: {
              materializationKinds: ['scm_hosting_token'],
            },
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.connectedAccountDescriptors).toEqual([
      expect.objectContaining({
        id: 'gitlab',
        kind: 'auth.connectedAccount',
        materialization: expect.objectContaining({
          materializationKinds: ['scm_hosting_token'],
        }),
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.auth-secret',
      version: '1.0.0',
      displayName: 'Acme Auth Secret',
      engines: { happier: '^1.0.0' },
      uses: ['connectedAccountDescriptors'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        connectedAccountDescriptors: [
          {
            id: 'gitlab',
            kind: 'auth.connectedAccount',
            version: '1',
            displayKey: 'plugins.acme.auth.gitlab.name',
            credentialKinds: ['token'],
            defaultCredentialKind: 'token',
            connectModes: [],
            tokenSetup: {
              tokenKind: 'personal-access-token',
              promptLabelKey: 'plugins.acme.auth.gitlab.tokenPrompt',
              missingValueErrorKey: 'plugins.acme.auth.gitlab.missingToken',
              accessToken: 'must-not-live-in-manifest',
            },
            ui: {
              connectCommand: 'happier connect gitlab --token',
              oauthAddActionModes: [],
            },
          },
        ],
      },
      permissions: { required: [] },
    }).success).toBe(false);
  });

  it('accepts nested MCP server/discovery-provider contribution families and rejects raw credential fields', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      uses: ['mcp'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.hosted',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-hosted',
              transport: 'hosted',
            },
          ],
          discoveryProviders: [
            {
              id: 'acme.discovery',
              kind: 'mcp.discoveryProvider',
              version: '1.0.0',
              agentId: 'acme',
            },
          ],
        },
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.mcp.servers.map((server: { name: string }) => server.name)).toEqual(['acme-hosted']);
    expect(parsed.contributes.mcp.discoveryProviders.map((provider: { agentId: string }) => provider.agentId)).toEqual(['acme']);
    expect(parsed.uses).toContain('mcp');

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.retired-mcp',
      version: '1.0.0',
      displayName: 'Acme Retired MCP',
      engines: { happier: '^1.0.0' },
      uses: ['mcp'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        mcp: {
          tools: [
            {
              id: 'acme.tool',
              kind: 'mcp.tool',
              version: '1.0.0',
              name: 'ext.acme.search',
            },
          ],
        },
      },
      permissions: { required: [] },
    }).success).toBe(false);

    const withRawCredential = {
      schemaVersion: 2,
      id: 'acme.mcp',
      version: '1.0.0',
      displayName: 'Acme MCP',
      engines: { happier: '^1.0.0' },
      uses: [],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        mcp: {
          servers: [
            {
              id: 'acme.remote',
              kind: 'mcp.server',
              version: '1.0.0',
              name: 'acme-remote',
              transport: 'http',
              url: 'https://mcp.example.test',
              clientSecret: 'raw-value',
            },
          ],
        },
      },
      permissions: {},
    };

    expect(manifestSchema!.safeParse(withRawCredential).success).toBe(false);
  });

  it('validates non-agent managed dependency contributions in nested contributes', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.managed-dependencies',
      version: '1.0.0',
      displayName: 'Acme Managed Dependencies',
      engines: { happier: '^0.2.0' },
      uses: ['managedDependencies'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        managedDependencies: [
          {
            id: 'acme-tool',
            key: 'acme-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.acme-tool',
            display: {
              name: 'Acme Tool',
            },
            description: 'Acme tool dependency',
            source: {
              kind: 'manual_only',
              setupUrl: 'https://example.com/acme-tool',
            },
            binary: {
              commands: ['acme-tool'],
              systemFirst: true,
            },
            defaultPolicy: {
              autoInstallWhenNeeded: false,
              autoUpdateMode: 'notify',
            },
            consent: {
              install: 'required',
              update: 'required',
            },
          },
        ],
      },
    });

    expect(parsed.contributes.managedDependencies).toEqual([
      expect.objectContaining({
        key: 'acme-tool',
        capabilityId: 'dep.acme-tool',
        source: expect.objectContaining({ kind: 'manual_only' }),
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.invalid-managed-dependencies',
      version: '1.0.0',
      displayName: 'Invalid Managed Dependencies',
      engines: { happier: '^0.2.0' },
      uses: ['managedDependencies'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        managedDependencies: [
          {
            id: 'bad-tool',
            key: 'bad-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.bad-tool',
            display: {
              name: 'Bad Tool',
            },
            description: 'Bad dependency',
            source: {
              kind: 'shell_script',
              command: 'curl https://example.com/install.sh | sh',
            },
            binary: {
              commands: ['bad-tool'],
              systemFirst: true,
            },
            defaultPolicy: {
              autoInstallWhenNeeded: false,
              autoUpdateMode: 'notify',
            },
            consent: {
              install: 'required',
              update: 'required',
            },
          },
        ],
      },
    }).success).toBe(false);
  });

  it('validates descriptor-driven settings contributions through the shared descriptor base', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.settings',
      version: '1.0.0',
      displayName: 'Acme Settings',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['settings'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        settings: [
          {
            id: 'acme.settings.main',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'text',
                displayKey: 'plugins.acme.settings.endpoint.label',
                order: 10,
                clearWhenEmpty: 'omit',
              },
              {
                id: 'enabled',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'boolean' },
                control: 'switch',
                displayKey: 'plugins.acme.settings.enabled.label',
                defaultBooleanValue: false,
                hidden: true,
              },
            ],
          },
        ],
      },
      permissions: { required: [] },
    });

    const settings = (parsed.contributes as { settings?: Array<{ fields: Array<Record<string, unknown>> }> }).settings;
    expect(settings?.[0]?.fields[0]).toMatchObject({
      id: 'endpoint',
      clearWhenEmpty: 'omit',
      hidden: false,
    });
    expect(settings?.[0]?.fields[1]).toMatchObject({
      id: 'enabled',
      defaultBooleanValue: false,
      hidden: true,
    });

    const invalidSecretDescriptor = {
      schemaVersion: 2,
      id: 'acme.settings',
      version: '1.0.0',
      displayName: 'Acme Settings',
      engines: { happier: '^1.0.0' },
      uses: ['settings'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        settings: [
          {
            id: 'acme.settings.main',
            fields: [
              {
                id: 'bad-secret',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'password',
                displayKey: 'plugins.acme.settings.secret.label',
                metadata: {
                  accessToken: 'raw-secret-value',
                  client_secret: 'raw-client-secret',
                },
              },
            ],
          },
        ],
      },
      permissions: {},
    };

    expect(manifestSchema!.safeParse(invalidSecretDescriptor).success).toBe(false);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.duplicate-settings-fields',
      version: '1.0.0',
      displayName: 'Duplicate Settings Fields',
      engines: { happier: '^1.0.0' },
      uses: ['settings'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        settings: [
          {
            id: 'acme.settings.main',
            fields: [
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'text',
                displayKey: 'plugins.acme.settings.endpoint.label',
              },
              {
                id: 'endpoint',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'string' },
                control: 'text',
                displayKey: 'plugins.acme.settings.endpointDuplicate.label',
              },
            ],
          },
        ],
      },
      permissions: {},
    }).success).toBe(false);
  });

  it('accepts agent-account settings contributions separately from plugin-local settings', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.agent.settings',
      version: '1.0.0',
      displayName: 'Acme Agent Settings',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        ...agentOwnerContributions('acme'),
        settings: [
          {
            id: 'acme.local.settings',
            fields: [
              {
                id: 'localToggle',
                kind: 'settings.field',
                version: '1.0.0',
                valueSchema: { type: 'boolean' },
                control: 'switch',
                displayKey: 'plugins.acme.settings.localToggle.label',
                defaultBooleanValue: true,
              },
            ],
          },
        ],
        agentSettings: [
          {
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            version: 1,
            storageScope: 'agentAccount',
            fields: [
              {
                id: 'acmeBackendMode',
                schema: { kind: 'enum', values: ['managed', 'external'] },
                default: 'managed',
                description: 'Preferred Acme backend mode',
                storageScope: 'account',
                ui: {
                  kind: 'enum',
                  title: { key: 'settingsProviders.plugins.acme.fields.acmeBackendMode.title' },
                  subtitle: { key: 'settingsProviders.plugins.acme.fields.acmeBackendMode.subtitle' },
                  enumOptions: [
                    {
                      id: 'managed',
                      title: { key: 'settingsProviders.plugins.acme.fields.acmeBackendMode.options.managed.title' },
                    },
                    {
                      id: 'external',
                      title: { key: 'settingsProviders.plugins.acme.fields.acmeBackendMode.options.external.title' },
                    },
                  ],
                },
              },
            ],
            ui: {
              title: { key: 'settingsProviders.plugins.acme.title' },
              sections: [
                {
                  id: 'acmeRuntime',
                  title: { key: 'settingsProviders.plugins.acme.sections.runtime.title' },
                  fields: ['acmeBackendMode'],
                },
              ],
            },
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.settings).toHaveLength(1);
    expect((parsed.contributes as { agentSettings?: readonly unknown[] }).agentSettings).toEqual([
      expect.objectContaining({
        id: 'acme.agentSettings.v1',
        agentId: 'acme',
        storageScope: 'agentAccount',
        fields: [
          expect.objectContaining({
            id: 'acmeBackendMode',
            schema: { kind: 'enum', values: ['managed', 'external'] },
            default: 'managed',
          }),
        ],
      }),
    ]);
  });

  it('rejects unsafe agent-account settings descriptors', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const result = manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.agent.settings',
      version: '1.0.0',
      displayName: 'Acme Agent Settings',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        ...agentOwnerContributions('acme'),
        agentSettings: [
          {
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            version: 1,
            storageScope: 'agentAccount',
            fields: [
              {
                id: 'apiSecret',
                schema: { kind: 'secret' },
                default: 'raw-secret-value',
                description: 'Bad secret material',
                storageScope: 'account',
              },
              {
                id: 'apiSecret',
                schema: { kind: 'boolean' },
                default: false,
                description: 'Duplicate key',
                storageScope: 'account',
              },
            ],
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(result.success).toBe(false);
  });

  it('allows non-secret token-budget and credential-reference agent settings while rejecting credential token keys', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const baseManifest = {
      schemaVersion: 2,
      id: 'acme.agent.settings',
      version: '1.0.0',
      displayName: 'Acme Agent Settings',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
    };

    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        ...agentOwnerContributions('acme'),
        agentSettings: [
          {
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            fields: [
              {
                id: 'tokenBudget',
                schema: { kind: 'positiveInteger', nullable: true },
                default: null,
                description: 'Maximum thinking token budget',
              },
              {
                id: 'credentialRef',
                schema: { kind: 'string' },
                default: '',
                description: 'Opaque credential reference, not credential material',
              },
            ],
          },
        ],
      },
    }).success).toBe(true);

    expect(manifestSchema!.safeParse({
      ...baseManifest,
      contributes: {
        ...agentOwnerContributions('acme'),
        agentSettings: [
          {
            id: 'acme.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'acme',
            fields: [
              {
                id: 'apiToken',
                schema: { kind: 'string' },
                default: '',
                description: 'Credential token',
              },
              {
                id: 'credentialSecret',
                schema: { kind: 'string' },
                default: '',
                description: 'Credential secret',
              },
            ],
          },
        ],
      },
    }).success).toBe(false);
  });

  it('rejects agent-account settings targeting agent ids not declared by the manifest', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const result = manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.agent.settings',
      version: '1.0.0',
      displayName: 'Acme Agent Settings',
      engines: { happier: '^1.0.0' },
      uses: ['agents'],
      entrypoints: { main: './dist/activate.js' },
      permissions: { required: [] },
      contributes: {
        ...agentOwnerContributions('acme'),
        agentSettings: [
          {
            id: 'claude.agentSettings.v1',
            kind: 'agentSettings.v1',
            agentId: 'claude',
            fields: [
              {
                id: 'enabled',
                schema: { kind: 'boolean' },
                default: true,
                description: 'Enabled',
              },
            ],
          },
        ],
      },
    });

    expect(result.success).toBe(false);
  });

  it('validates execution-run profile contributions through the shared descriptor base', () => {
    const manifestSchema = readSchemaExport('PluginManifestV2Schema');
    expect(manifestSchema).toBeDefined();

    const parsed = manifestSchema!.parse({
      schemaVersion: 2,
      id: 'acme.execution-runs',
      version: '1.0.0',
      displayName: 'Acme Execution Runs',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['executionRunProfiles'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        executionRunProfiles: [
          {
            id: 'acme.review.profile',
            kind: 'executionRun.profile',
            version: '1.0.0',
            intent: 'review',
            displayKey: 'plugins.acme.executionRuns.review.label',
            order: 10,
            hidden: true,
          },
        ],
      },
      permissions: { required: [] },
    });

    expect(parsed.contributes.executionRunProfiles).toEqual([
      expect.objectContaining({
        id: 'acme.review.profile',
        kind: 'executionRun.profile',
        intent: 'review',
        hidden: true,
        redaction: 'none',
      }),
    ]);

    expect(manifestSchema!.safeParse({
      schemaVersion: 2,
      id: 'acme.execution-runs.secret',
      version: '1.0.0',
      displayName: 'Acme Execution Runs Secret',
      engines: {
        happier: '^1.0.0',
      },
      uses: ['executionRunProfiles'],
      entrypoints: { main: './dist/activate.js' },
      contributes: {
        executionRunProfiles: [
          {
            id: 'acme.review.profile',
            kind: 'executionRun.profile',
            version: '1.0.0',
            intent: 'review',
            displayKey: 'plugins.acme.executionRuns.review.label',
            metadata: {
              accessToken: 'secret',
            },
          },
        ],
      },
      permissions: { required: [] },
    }).success).toBe(false);
  });
});
