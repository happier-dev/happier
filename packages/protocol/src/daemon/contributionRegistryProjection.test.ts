import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginReactNativeCrashReportRequestV1Schema,
  DaemonPluginReactNativeCrashReportResponseV1Schema,
  DaemonPluginUiArtifactBytesReadRequestSchema,
  DaemonPluginUiArtifactBytesReadResponseSchema,
  PluginProjectionV2Schema,
} from './contributionRegistryProjection.js';
import * as protocol from '../index.js';

describe('daemon contribution registry projection (wire)', () => {
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
        hooksById: {},
        resourcesById: {},
        uiDescriptorsById: {},
        diagnostics: [],
      },
    });

    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(2);
    expect(parsed.projection.installedPackagesById['acme.plugin']?.displayName).toBe('Acme Plugin');
  });

  it('parses v2 plugin projection descriptors without executable handler internals', () => {
    expect(typeof PluginProjectionV2Schema?.parse).toBe('function');
    expect(typeof (protocol as { PluginProjectedHookV2Schema?: unknown }).PluginProjectedHookV2Schema).toBe('object');
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
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
          priority: 10,
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
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
          surface: 'settings',
          title: 'Acme Settings',
          order: 10,
          tone: 'info',
          featureGate: 'features.acme.settings.enabled',
          helpUrl: 'https://example.com/acme/settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              description: 'Turn on Acme',
              order: 2,
              groupId: null,
              featureGate: null,
              options: [],
            },
            {
              id: 'runRefresh',
              type: 'action',
              title: 'Run refresh',
              actionId: 'acme.plugin.refresh',
              order: 1,
              groupId: 'actions',
              featureGate: 'features.acme.refresh.enabled',
              options: [],
            },
          ],
        },
      },
      diagnostics: [
        {
          severity: 'warning',
          code: 'plugin.futureCapability',
          message: 'Unsupported future capability',
          pluginId: 'acme.plugin',
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.plugin.refresh']?.available).toBe(true);
    expect(parsed.hooksById?.['acme.plugin.spawn-env']?.eventId).toBe('agent.spawnEnv.augment');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.surface).toBe('settings');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.order).toBe(10);
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.tone).toBe('info');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.helpUrl).toBe('https://example.com/acme/settings');
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.fields[0]).toMatchObject({
      id: 'enabled',
      type: 'boolean',
      title: 'Enabled',
    });
    expect(parsed.uiDescriptorsById['acme.plugin.settings']?.fields[1]).toMatchObject({
      id: 'runRefresh',
      type: 'action',
      actionId: 'acme.plugin.refresh',
    });

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

  it('parses generic plugin-local settings metadata without exposing setting values', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          storageScope: 'pluginLocal',
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
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
      uiDescriptorsById: {},
    });

    expect(parsed.settingsById['acme.hooks.settings']?.storageScope).toBe('pluginLocal');
    expect(parsed.settingsById['acme.hooks.settings']?.fields.map((field) => field.id)).toEqual([
      'apiToken',
      'enabled',
    ]);
    expect(parsed.uiDescriptorsById).toEqual({});

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          storageScope: 'pluginLocal',
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
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
          storageScope: 'pluginLocal',
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

  it('parses sibling-owned non-agent family projections without changing core projection fields', () => {
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
              title: 'GitHub',
              hostPattern: 'github.com',
            },
          },
        },
      },
    });

    expect(parsed.familiesById.scmHostingProviders?.entriesById.github).toEqual({
      id: 'github',
      pluginId: 'acme.scm',
      title: 'GitHub',
      hostPattern: 'github.com',
    });
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

  it('defines a daemon artifact-byte read contract keyed by projected embedded-web cache identity', () => {
    const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      machineId: 'm1',
      cacheIdentity: {
        pluginId: 'acme.preview',
        contributionId: 'embedded-preview',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        hostAppVersion: '2.0.0',
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.2.0',
        platform: 'web',
        channel: 'internal',
        projectionGeneration: 12,
      },
    });

    expect(request.cacheIdentity.artifactDigest).toBe(`sha256:${'c'.repeat(64)}`);
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      cacheIdentity: request.cacheIdentity,
      artifact: {
        pluginId: 'acme.preview',
        contributionId: 'embedded-preview',
        artifactKind: 'embeddedWebBundle',
        digest: `sha256:${'c'.repeat(64)}`,
        contentType: 'text/javascript',
        byteSize: 15,
      },
      bytesBase64: 'ZXhwb3J0IGRlZmF1bHQ=',
    })).toMatchObject({
      ok: true,
      artifact: {
        artifactKind: 'embeddedWebBundle',
        digest: `sha256:${'c'.repeat(64)}`,
        contentType: 'text/javascript',
      },
    });
  });
});
