import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginReactNativeCrashReportRequestV1Schema,
  DaemonPluginReactNativeCrashReportResponseV1Schema,
  DaemonPluginStructuredMessageActionExecuteRequestSchema,
  DaemonPluginStructuredMessageActionExecuteResponseSchema,
  DaemonPluginStructuredMessageResolveRequestSchema,
  DaemonPluginStructuredMessageResolveResponseSchema,
  DaemonPluginUiArtifactBytesReadRequestSchema,
  DaemonPluginUiArtifactBytesReadResponseSchema,
  PluginProjectedActionV2Schema,
  PluginProjectionV2Schema,
} from './contributionRegistryProjection.js';
import * as protocol from '../index.js';

describe('daemon contribution registry projection (wire)', () => {
  it('preserves exact non-safe action confirmation presentation and fails closed on invalid combinations', () => {
    const confirmation = {
      title: { key: 'actions.delete.title', fallback: 'Delete workspace?' },
      body: { key: 'actions.delete.body', fallback: 'This cannot be undone.' },
      confirmLabel: { key: 'actions.delete.confirm', fallback: 'Delete' },
    } as const;
    const projectedAction = {
      id: 'delete-workspace',
      pluginId: 'acme.workspace',
      title: 'Delete workspace',
      scopes: ['workspace'],
      surfaces: ['ui'],
      placement: 'detailsPanel',
      dangerLevel: 'destructive',
      confirmation,
    } as const;

    expect(PluginProjectedActionV2Schema.parse(projectedAction)).toMatchObject({
      dangerLevel: 'destructive',
      confirmation,
    });
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      dangerLevel: 'safe',
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: undefined,
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: { ...confirmation, input: { secret: 'must-not-project' } },
    }).success).toBe(false);
  });

  it('admits UI as an explicit plugin action invocation surface', () => {
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedGeneration: '7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'ui',
    }).executionSurface).toBe('ui');
  });

  it('bounds structured-message resource references at the wire boundary', () => {
    expect(DaemonPluginStructuredMessageResolveRequestSchema.safeParse({
      machineId: 'm1',
      expectedGeneration: '7',
      kind: 'acme.preview/preview-card.v1',
      payload: {},
      resourceRefs: Array.from({ length: 65 }, (_, index) => `resource-${index}`),
      facts: {},
    }).success).toBe(false);

  });

  it('rejects non-JSON structured-message action results at the wire boundary', () => {
    expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse({
      ok: true,
      result: () => undefined,
    }).success).toBe(false);
  });

  it('accepts canonical empty resource bytes and rejects malformed structured-message base64', () => {
    const response = (bytesBase64: string) => ({
      ok: true as const,
      model: {
        identity: {
          pluginId: 'acme.preview',
          localId: 'preview-card',
          qualifiedId: 'acme.preview/preview-card',
          generation: '7',
        },
        kind: 'acme.preview/preview-card.v1',
        title: 'Preview',
        payload: {},
        renderer: {
          identity: { pluginId: 'acme.preview', localId: 'summary-card' },
          qualifiedId: 'acme.preview/summary-card',
          generation: '7',
        },
        actions: [],
        resources: [{
          identity: { pluginId: 'acme.preview', localId: 'empty' },
          qualifiedId: 'acme.preview/empty',
          generation: '7',
        }],
        fallback: { kind: 'summary' as const, template: 'Preview unavailable' },
        visible: true,
      },
      renderer: {
        identity: {
          pluginId: 'acme.preview',
          localId: 'summary-card',
          qualifiedId: 'acme.preview/summary-card',
          generation: '7',
        },
        visible: true,
        requiredHostMethods: [],
        root: { kind: 'text', text: 'Preview' },
        nodes: [],
      },
      resources: [{
        reference: {
          identity: { pluginId: 'acme.preview', localId: 'empty' },
          qualifiedId: 'acme.preview/empty',
          generation: '7',
        },
        kind: 'asset' as const,
        contentType: 'application/octet-stream',
        digest: `sha256:${'a'.repeat(64)}`,
        bytesBase64,
      }],
    });

    expect(DaemonPluginStructuredMessageResolveResponseSchema.safeParse(response('')).success).toBe(true);
  });

  it('rejects malformed structured-message base64', () => {
    const valid = DaemonPluginStructuredMessageResolveResponseSchema.safeParse({
      ok: false,
      code: 'not-used',
      reason: 'unavailable',
    });
    expect(valid.success).toBe(true);

    const resourceSchema = DaemonPluginStructuredMessageResolveResponseSchema.options[0].shape.resources.element;
    expect(resourceSchema.safeParse({
      reference: {
        identity: { pluginId: 'acme.preview', localId: 'asset' },
        qualifiedId: 'acme.preview/asset',
        generation: '7',
      },
      kind: 'asset',
      contentType: 'application/octet-stream',
      digest: `sha256:${'a'.repeat(64)}`,
      bytesBase64: 'not base64!',
    }).success).toBe(false);
    expect(resourceSchema.safeParse({
      reference: {
        identity: { pluginId: 'acme.preview', localId: 'asset' },
        qualifiedId: 'acme.preview/asset',
        generation: '7',
      },
      kind: 'asset',
      contentType: 'application/octet-stream',
      digest: `sha256:${'a'.repeat(64)}`,
      bytesBase64: 'AB==',
    }).success).toBe(false);
  });

  it('parses a minimal v1 describe request/response payload', () => {
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1' })).toEqual({
      machineId: 'm1',
    });

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 1,
        agentsById: {
          custom: { id: 'custom', title: 'Custom', channel: 'plugin' },
        },
        backendsById: {
          b1: { id: 'b1', providerId: 'custom' },
        },
      },
    });
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(1);
    expect(parsed.projection.agentsById.custom?.id).toBe('custom');
    expect(parsed.projection.backendsById.b1?.agentId).toBe('custom');
  });

  it('accepts a deployed legacy managed-dependency title while current writers omit it', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      familiesById: {
        managedDependencies: {
          family: 'managedDependencies',
          entriesById: {
            'acme.runtime/runtime': {
              id: 'runtime',
              pluginId: 'acme.runtime',
              title: 'Runtime',
              executable: 'runtime',
            },
          },
        },
      },
    }).success).toBe(true);
  });

  it('normalizes deployed provider-vocabulary projections to canonical agent fields', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      providersById: {
        custom: {
          providerId: 'custom',
          title: 'Custom',
          providerAgentId: 'claude',
        },
      },
      backendsById: {
        b1: {
          id: 'b1',
          providerId: 'custom',
          providerAgentId: 'claude',
        },
      },
    });

    expect(parsed.agentsById.custom).toEqual(expect.objectContaining({
      id: 'custom',
      catalogAgentId: 'claude',
    }));
    expect(parsed.backendsById.b1).toEqual(expect.objectContaining({
      agentId: 'custom',
      catalogAgentId: 'claude',
    }));
    expect(parsed).not.toHaveProperty('providersById');
    expect(parsed.backendsById.b1).not.toHaveProperty('providerId');
  });

  it('rejects projection entries whose canonical and deployed identities conflict', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      agentsById: {},
      backendsById: {
        b1: {
          id: 'b1',
          agentId: 'codex',
          providerId: 'claude',
        },
      },
    }).success).toBe(false);
  });

  it('accepts a typed React Native host runtime identity and rejects malformed known fields', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        appVersion: '0.2.1',
        nativeApplicationVersion: '0.2.0',
        nativeBuildVersion: '101',
        applicationId: 'dev.happier.app',
        rawUpdateChannel: 'internalpreview',
        reactVersion: '19.2.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: 'runtime-55',
        hermesVersion: '0.15.0',
        availableNativeCapabilities: ['host.native.camera'],
      },
    });

    expect(parsed.reactNativeHostRuntimeIdentity).toEqual({
      platform: 'ios',
      channel: 'internal',
      appVersion: '0.2.1',
      nativeApplicationVersion: '0.2.0',
      nativeBuildVersion: '101',
      applicationId: 'dev.happier.app',
      rawUpdateChannel: 'internalpreview',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      expoRuntimeVersion: 'runtime-55',
      hermesVersion: '0.15.0',
      availableNativeCapabilities: ['host.native.camera'],
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'web', channel: 'internal' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'preview' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        availableNativeCapabilities: [123],
      },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntimeIntegrated: true,
      },
    }).success).toBe(false);
  });

  it('carries optional reported ScriptManager readiness on the host runtime identity and stays fail-closed when absent', () => {
    const integrated = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: {
          integrated: true,
          installedArtifactLoaderAvailable: true,
        },
      },
    });
    expect(integrated.reactNativeHostRuntimeIdentity?.scriptManagerRuntime).toEqual({
      integrated: true,
      installedArtifactLoaderAvailable: true,
    });

    // Omitting readiness parses (default fail-closed: no reported readiness).
    const absent = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
    });
    expect(absent.reactNativeHostRuntimeIdentity).not.toHaveProperty('scriptManagerRuntime');

    // A partial readiness report (one bit missing) cannot silently flip the gate.
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: { integrated: true },
      },
    }).success).toBe(false);

    // Unknown readiness keys are rejected (strict).
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        scriptManagerRuntime: {
          integrated: true,
          installedArtifactLoaderAvailable: true,
          unexpected: true,
        },
      },
    }).success).toBe(false);
  });

  it('accepts only a complete typed React Native web loader capability', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    });
    expect(parsed.reactNativeWebLoaderCapability).toEqual({
      integrated: true,
      installedArtifactLoaderAvailable: true,
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: { integrated: true },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
        unexpected: true,
      },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    }).success).toBe(false);
  });

  it('parses a v2 describe response payload that carries the authoritative plugin projection', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 2,
        generation: 7,
        installedPackagesById: {
          'acme.plugin': {
            id: 'acme.plugin',
            displayName: 'Acme Plugin',
            version: '1.2.3',
            enabled: true,
            source: {
              kind: 'path',
              locator: '/tmp/acme',
            },
            digest: 'sha256:manifest',
          },
        },
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        diagnostics: [],
      },
    });

    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(2);
    expect(parsed.projection.installedPackagesById['acme.plugin']?.displayName).toBe('Acme Plugin');
  });

  it('parses v2 plugin projection descriptors without executable handler internals', () => {
    expect(typeof PluginProjectionV2Schema?.parse).toBe('function');
    expect((protocol as { PluginProjectedHookV2Schema?: unknown }).PluginProjectedHookV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectionV2Schema?: unknown }).ExtensionProjectionV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectedHookV2Schema?: unknown }).ExtensionProjectedHookV2Schema).toBeUndefined();

    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      installedPackagesById: {
        'acme.plugin': {
          id: 'acme.plugin',
          displayName: 'Acme Plugin',
          version: '1.2.3',
          enabled: true,
          source: {
            kind: 'path',
            locator: '/tmp/acme',
          },
        },
      },
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['agent'],
          placement: 'primary',
          dangerLevel: 'safe',
          available: true,
        },
      },
      toolsById: {
        'acme.plugin.search': {
          id: 'acme.plugin.search',
          pluginId: 'acme.plugin',
          title: 'Search Acme',
          exposesToAgent: true,
        },
      },
      commandsById: {
        'acme.plugin.reload': {
          id: 'acme.plugin.reload',
          pluginId: 'acme.plugin',
          title: 'Reload Acme',
          surfaces: ['agentSlash'],
          tokens: ['acme-reload'],
        },
      },
      resourcesById: {
        'acme.plugin.prompt': {
          id: 'acme.plugin.prompt',
          pluginId: 'acme.plugin',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
      },
      diagnostics: [
        {
          version: 1,
          id: 'acme.plugin:normalization:plugin:0',
          data: {
            severity: 'warning',
            code: 'plugin.futureCapability',
            message: 'Unsupported future capability',
          },
          plugin: { id: 'acme.plugin', version: '1.2.3', source: 'localPath' },
          stage: 'normalization',
          host: 'daemon',
          platform: 'darwin',
          occurredAtMs: 1,
          resolution: { state: 'current' },
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.plugin.refresh']?.available).toBe(true);
    expect(parsed).not.toHaveProperty('hooksById');
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placement: 'primary',
          dangerLevel: 'safe',
          handler: {
            target: 'daemon',
            exportName: 'refreshAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      executableRegistryPath: '/tmp/acme/registry.json',
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      agentsById: {
        acme: {
          id: 'acme',
          title: 'Acme',
          handler: {
            target: 'daemon',
            exportName: 'loadAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      backendsById: {
        'acme.backend': {
          id: 'acme.backend',
          providerId: 'acme',
          handler: {
            target: 'daemon',
            exportName: 'launchAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
          surface: 'settings',
          title: 'Acme Settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              componentModule: './SettingsPanel.js',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'spawn.augmentEnv',
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
          handler: {
            target: 'daemon',
            exportName: 'augmentSpawnEnv',
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects the retired uiDescriptors projection family', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      uiDescriptorsById: {},
    }).success).toBe(false);
  });

  it('bounds projected agent-owned provider environment keys without projecting provider credentials', () => {
    const base = {
      v: 2 as const,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
        },
      },
    };
    expect(PluginProjectionV2Schema.parse(base).agentsById.codex?.providerOwnedEnvironmentKeys)
      .toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: Array.from({ length: 65 }, (_, index) => `PROVIDER_KEY_${index}`) } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['not-an-env-key'] } },
    }).success).toBe(false);
  });

  it('projects a bounded generation-pinned external-session browse descriptor for an Agent', () => {
    const externalSessions = {
      agent: {
        pluginId: 'acme.external-sessions',
        localId: 'acme-agent',
      },
      generation: 17,
      operations: {
        listCandidates: true,
        resolveLinkIdentity: true,
        pageTranscript: true,
        readAfterTranscript: true,
      },
      sources: [{
        sourceKind: 'acmeArchive',
        schema: {
          passthrough: false,
          fields: [{ name: 'kind', kind: 'literal', value: 'acmeArchive' }],
        },
        key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    } as const;
    const base = {
      v: 2 as const,
      generation: 17,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions,
        },
      },
    };

    expect(PluginProjectionV2Schema.parse(base).agentsById['acme-agent']?.externalSessions)
      .toEqual(externalSessions);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: {
            ...externalSessions,
            operations: { ...externalSessions.operations, takeover: true },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: { ...externalSessions, generation: -1 },
        },
      },
    }).success).toBe(false);
  });

  it('parses generic local settings metadata without exposing setting values', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          storageScope: 'local',
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              displayKey: 'plugins.acme.apiToken.label',
              descriptionKey: 'plugins.acme.apiToken.description',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
            {
              id: 'enabled',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'boolean' },
              valueType: 'boolean',
              control: 'switch',
              displayKey: 'plugins.acme.enabled.label',
              redaction: 'none',
              clearWhenEmpty: 'persist',
              defaultBooleanValue: true,
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    });

    expect(parsed.settingsById['acme.hooks.settings']?.storageScope).toBe('local');
    expect(parsed.settingsById['acme.hooks.settings']?.fields.map((field) => field.id)).toEqual([
      'apiToken',
      'enabled',
    ]);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          storageScope: 'local',
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
              value: 'super-secret-token',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          storageScope: 'local',
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: {
                type: 'string',
                default: 'schema-secret-default',
                enum: ['schema-secret-option'],
              },
              valueType: 'string',
              control: 'password',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    }).success).toBe(false);
  });

  it('parses React Native crash-disable report payloads with cache identity and threshold reason', () => {
    const cacheIdentity = {
      pluginId: 'acme.preview',
      contributionId: 'native-preview',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      hostAppVersion: '2.0.0',
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      platform: 'ios',
      channel: 'internal',
      nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
      projectionGeneration: 12,
    };

    expect(DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: {
        surfaceId: 'surface_1',
        cacheIdentity,
        disabledReason: 'render_error_threshold',
        crashCount: 2,
        startupFailureCount: 0,
        observedAtMs: 1_000,
        diagnostics: ['threshold_reached'],
      },
    })).toEqual({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: {
        surfaceId: 'surface_1',
        cacheIdentity,
        disabledReason: 'render_error_threshold',
        crashCount: 2,
        startupFailureCount: 0,
        observedAtMs: 1_000,
        diagnostics: ['threshold_reached'],
      },
    });

    expect(() => DaemonPluginReactNativeCrashReportRequestV1Schema.parse({
      protocolVersion: 1,
      machineId: 'machine_1',
      report: {
        surfaceId: 'surface_1',
        cacheIdentity,
        disabledReason: 'other',
        crashCount: 2,
        startupFailureCount: 0,
        observedAtMs: 1_000,
      },
    })).toThrow();

    expect(DaemonPluginReactNativeCrashReportResponseV1Schema.parse({
      protocolVersion: 1,
      ok: false,
      code: 'projection_identity_mismatch',
      diagnostics: ['react_native_crash_report_projection_identity_mismatch'],
    })).toEqual({
      protocolVersion: 1,
      ok: false,
      code: 'projection_identity_mismatch',
      diagnostics: ['react_native_crash_report_projection_identity_mismatch'],
    });

    expect(DaemonPluginReactNativeCrashReportResponseV1Schema.parse({
      protocolVersion: 1,
      ok: true,
      contributionKey: 'acme.preview:native-preview',
      disabled: true,
    })).toEqual({
      protocolVersion: 1,
      ok: true,
      contributionKey: 'acme.preview:native-preview',
      disabled: true,
    });
  });

  it('rejects unknown projection families and unknown family entry fields', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              id: 'github',
              pluginId: 'acme.scm',
              localId: 'github',
              kind: 'github',
              displayName: 'GitHub',
              description: 'GitHub hosting',
              baseUrl: 'https://github.com',
              urlSafety: {},
              capabilities: {},
              operations: {},
              authService: 'github',
            },
          },
        },
      },
    });

    expect(parsed.familiesById.scmHostingProviders?.entriesById.github).toEqual({
      id: 'github',
      pluginId: 'acme.scm',
      localId: 'github',
      kind: 'github',
      displayName: 'GitHub',
      description: 'GitHub hosting',
      baseUrl: 'https://github.com',
      urlSafety: {},
      capabilities: {},
      operations: {},
      authService: 'github',
    });
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        unknownFamily: {
          family: 'unknownFamily',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              ...parsed.familiesById.scmHostingProviders?.entriesById.github,
              hostPattern: 'github.com',
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmBackends',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(parsed.agentsById).toEqual({});
    expect(parsed.backendsById).toEqual({});
  });

  it('defines a daemon artifact-byte read contract keyed by projected React Native cache identity', () => {
    const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      machineId: 'm1',
      cacheIdentity: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactDigest: `sha256:${'a'.repeat(64)}`,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
        platform: 'ios',
        channel: 'internal',
        nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
        projectionGeneration: 12,
      },
    });

    expect(request.cacheIdentity.artifactDigest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(request.cacheIdentity.projectionGeneration).toBe(12);
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...request,
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      reactNativeWebLoaderCapability: {
        integrated: true,
        installedArtifactLoaderAvailable: true,
      },
    }).success).toBe(false);
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      cacheIdentity: request.cacheIdentity,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'native-preview',
        artifactKind: 'reactNativeBundle',
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
        byteSize: 9,
      },
      bytesBase64: 'Ly8gYnVuZGxl',
    })).toMatchObject({
      ok: true,
      artifact: {
        digest: `sha256:${'a'.repeat(64)}`,
        format: 'plainJs',
      },
    });

    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: false,
      code: 'artifact_not_found',
      diagnostics: ['react_native_artifact_not_found'],
    })).toEqual({
      ok: false,
      code: 'artifact_not_found',
      diagnostics: ['react_native_artifact_not_found'],
    });
  });

});
