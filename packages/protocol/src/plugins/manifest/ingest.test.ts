import { describe, expect, it } from 'vitest';

import { ingestPluginManifestV2, resolvePluginManifestSetReferencesV2 } from './ingest.js';
import {
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  PluginManifestHostAccessV2Schema,
} from './v2.js';
import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
} from '../contributions/catalog.js';
import {
  MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
  PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
} from '../contributions/ui/declarativeDocument.js';
import {
  COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
  ComposerControlStateV1Schema,
  MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
} from '../ui/composer.js';
import { MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '../../runtime/input/composerAttachmentV1.js';
import {
  PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
  PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '../../automations/automationEventV1.js';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'com.acme.fixture',
    version: '1.0.0',
    displayName: 'Fixture',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/plugin.js' },
    hostAccess: { required: [], optional: [] },
    contributes: {},
    ...overrides,
  };
}

function serializedManifestWithMetadataDepth(depth: number): string {
  const nested = `${'{"next":'.repeat(depth)}null${'}'.repeat(depth)}`;
  return JSON.stringify(manifest({ metadata: { chain: null } })).replace(
    '"chain":null',
    `"chain":${nested}`,
  );
}

function managedDependency(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Managed',
    description: 'Managed executable',
    sources: [{ kind: 'system', executableNames: [id] }],
    executable: id,
  };
}

function connectedAccountDescriptor(id: string): Record<string, unknown> {
  return {
    id,
    title: 'Account',
    authentication: {
      defaultModeId: 'manual',
      modes: [{
        id: 'manual',
        kind: 'manual',
        outcomeReconciliation: 'none',
        fields: [{
          id: 'token',
          title: 'Token',
          schema: { type: 'string' },
          secret: true,
        }],
      }],
    },
  };
}

const AUTOMATION_SOURCE_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repository: { type: 'string', minLength: 1, maxLength: 512 },
  },
  required: ['repository'],
} as const;

function automationSetupResultSchema(
  sourceConfigSchema: Record<string, unknown> = AUTOMATION_SOURCE_CONFIG_SCHEMA,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      v: { type: 'integer', const: 1 },
      sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
      sourceContractVersion: { type: 'integer', const: 1 },
      sourceConfig: sourceConfigSchema,
      displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
  };
}

function automationSetupAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'arbitrary-source-setup',
    title: 'Set up source',
    scopes: ['global'],
    surfaces: ['plugin'],
    execution: { target: 'daemon' },
    resultSchema: automationSetupResultSchema(),
    dangerLevel: 'safe',
    ...overrides,
  };
}

function historyGapResetAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'baseline-history-gap',
    title: 'Resume event source',
    scopes: ['global'],
    surfaces: ['plugin'],
    execution: { target: 'daemon' },
    inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
    dangerLevel: 'writesLocal',
    confirmation: {
      title: {
        key: 'automation.historyGapReset.title',
        fallback: 'Start a new baseline',
      },
      body: {
        key: 'automation.historyGapReset.body',
        fallback: 'Events in the history gap are not replayed.',
      },
    },
    ...overrides,
  };
}

function automationEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'repository-updated',
    kind: 'event',
    title: 'Repository updated',
    // An Automation-eligible Event publishes the payload its filters and
    // mappings are authored against, so the fixture declares one too.
    payloadSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { repository: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['repository'],
    },
    automation: {
      v: 1,
      eligible: true,
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull'],
        sourceConfigSchema: AUTOMATION_SOURCE_CONFIG_SCHEMA,
        setupActionRef: {
          pluginId: 'com.acme.fixture',
          localId: 'arbitrary-source-setup',
        },
      },
    },
    ...overrides,
  };
}

describe('canonical plugin manifest ingestion', () => {
  it('admits an Event Automation setup Action only through its exact qualified same-plugin declaration', () => {
    const parsed = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [automationSetupAction()],
        events: [automationEvent()],
      },
    }));

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(resolvePluginManifestSetReferencesV2([parsed.manifest])).toEqual({ ok: true });
  });

  it('rejects dangling, cross-plugin, wrong-family, non-plugin, and noncanonical Event Automation setup bindings', () => {
    const cases: readonly Readonly<{
      name: string;
      contributes: Record<string, unknown>;
      code: 'plugin_manifest_dangling_reference' | 'plugin_manifest_wrong_family_reference' | 'plugin_manifest_invalid';
    }>[] = [
      {
        name: 'dangling Action',
        contributes: { events: [automationEvent()] },
        code: 'plugin_manifest_dangling_reference',
      },
      {
        name: 'cross-plugin Action',
        contributes: {
          actions: [automationSetupAction()],
          events: [automationEvent({
            automation: {
              v: 1,
              eligible: true,
              source: {
                sourceContractVersion: 1,
                supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: AUTOMATION_SOURCE_CONFIG_SCHEMA,
                setupActionRef: { pluginId: 'com.acme.other', localId: 'arbitrary-source-setup' },
              },
            },
          })],
        },
        code: 'plugin_manifest_dangling_reference',
      },
      {
        name: 'wrong-family Action',
        contributes: {
          resources: [{
            id: 'arbitrary-source-setup',
            kind: 'asset',
            path: 'source-setup.txt',
            contentType: 'text/plain',
          }],
          events: [automationEvent()],
        },
        code: 'plugin_manifest_wrong_family_reference',
      },
      {
        name: 'non-plugin Action',
        contributes: {
          actions: [automationSetupAction({
            surfaces: ['ui'],
            placementBindings: ['toolbar'],
          })],
          events: [automationEvent()],
        },
        code: 'plugin_manifest_invalid',
      },
      {
        name: 'noncanonical result schema',
        contributes: {
          actions: [automationSetupAction({ resultSchema: { type: 'object' } })],
          events: [automationEvent()],
        },
        code: 'plugin_manifest_invalid',
      },
    ];

    for (const testCase of cases) {
      expect(ingestPluginManifestV2(manifest({ contributes: testCase.contributes }))).toEqual({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: testCase.code,
            path: ['contributes', 'events', 0, 'automation', 'source', 'setupActionRef'],
          }),
        ]),
      });
    }
  });

  it('admits a history-gap recovery Action only through its exact same-plugin Action contract', () => {
    const recoveryEvent = automationEvent({
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['checkpointedPull'],
          sourceConfigSchema: AUTOMATION_SOURCE_CONFIG_SCHEMA,
          setupActionRef: {
            pluginId: 'com.acme.fixture',
            localId: 'arbitrary-source-setup',
          },
          historyGapResetActionRef: {
            pluginId: 'com.acme.fixture',
            localId: 'baseline-history-gap',
          },
        },
      },
    });
    const accepted = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [automationSetupAction(), historyGapResetAction()],
        events: [recoveryEvent],
      },
    }));
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) expect(resolvePluginManifestSetReferencesV2([accepted.manifest])).toEqual({ ok: true });

    const cases: readonly Readonly<{
      name: string;
      contributes: Record<string, unknown>;
      code: 'plugin_manifest_dangling_reference' | 'plugin_manifest_wrong_family_reference' | 'plugin_manifest_invalid';
    }>[] = [
      {
        name: 'dangling Action',
        contributes: { actions: [automationSetupAction()], events: [recoveryEvent] },
        code: 'plugin_manifest_dangling_reference',
      },
      {
        name: 'wrong-family Action',
        contributes: {
          actions: [automationSetupAction()],
          resources: [{
            id: 'baseline-history-gap',
            kind: 'asset',
            path: 'baseline.txt',
            contentType: 'text/plain',
          }],
          events: [recoveryEvent],
        },
        code: 'plugin_manifest_wrong_family_reference',
      },
      {
        name: 'non-plugin Action',
        contributes: {
          actions: [
            automationSetupAction(),
            historyGapResetAction({ surfaces: ['ui'], placementBindings: ['toolbar'] }),
          ],
          events: [recoveryEvent],
        },
        code: 'plugin_manifest_invalid',
      },
      {
        name: 'noncanonical input schema',
        contributes: {
          actions: [automationSetupAction(), historyGapResetAction({ inputSchema: { type: 'object' } })],
          events: [recoveryEvent],
        },
        code: 'plugin_manifest_invalid',
      },
      {
        name: 'noncanonical result schema',
        contributes: {
          actions: [automationSetupAction(), historyGapResetAction({ resultSchema: { type: 'object' } })],
          events: [recoveryEvent],
        },
        code: 'plugin_manifest_invalid',
      },
    ];

    for (const testCase of cases) {
      expect(ingestPluginManifestV2(manifest({ contributes: testCase.contributes }))).toEqual({
        ok: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: testCase.code,
            path: ['contributes', 'events', 0, 'automation', 'source', 'historyGapResetActionRef'],
          }),
        ]),
      });
    }
  });

  it('admits only a same-plugin declared webhook for a durable Event Automation source', () => {
    const webhook = {
      id: 'repository-webhook',
      title: 'Repository webhook',
      verifier: { kind: 'github_hmac_sha256_v1', routing: 'providerInstallation' },
      handlerAction: { localId: 'arbitrary-source-setup' },
    };
    const durableEvent = automationEvent({
      automation: {
        v: 1,
        eligible: true,
        source: {
          sourceContractVersion: 1,
          supportedObservationTransports: ['durablePush'],
          sourceConfigSchema: AUTOMATION_SOURCE_CONFIG_SCHEMA,
          setupActionRef: {
            pluginId: 'com.acme.fixture',
            localId: 'arbitrary-source-setup',
          },
          webhookContributionRef: {
            pluginId: 'com.acme.fixture',
            localId: 'repository-webhook',
          },
        },
      },
    });
    const accepted = ingestPluginManifestV2(manifest({
      contributes: { actions: [automationSetupAction()], webhooks: [webhook], events: [durableEvent] },
    }));
    expect(accepted).toMatchObject({ ok: true });
    if (accepted.ok) expect(resolvePluginManifestSetReferencesV2([accepted.manifest])).toEqual({ ok: true });

    const wrongFamily = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [
          automationSetupAction(),
          automationSetupAction({ id: 'repository-webhook' }),
        ],
        events: [durableEvent],
      },
    }));
    expect(wrongFamily).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_wrong_family_reference',
          path: ['contributes', 'events', 0, 'automation', 'source', 'webhookContributionRef'],
        }),
      ]),
    });
  });

  it('admits a transcript activity only through its same-plugin bounded dynamic Resource profile', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{
          id: 'cancel-import',
          title: 'Cancel import',
          scopes: ['session'],
          surfaces: ['ui'],
          placementBindings: ['rowAction'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
        resources: [{
          id: 'import-progress',
          source: 'dynamic',
          kind: 'config',
          contentType: 'application/vnd.happier.transcript-activity+json;v=1',
          maxBytes: 65_536,
          scope: 'session',
        }],
        transcriptActivities: [{
          id: 'import-progress-card',
          resourceId: 'import-progress',
          actions: ['cancel-import'],
        }],
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        contributes: {
          transcriptActivities: [{
            id: 'import-progress-card',
            resourceId: 'import-progress',
            actions: ['cancel-import'],
          }],
        },
      },
    });
  });

  it('rejects a transcript activity backed by a global dynamic Resource', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{
          id: 'import-progress',
          source: 'dynamic',
          kind: 'config',
          contentType: 'application/vnd.happier.transcript-activity+json;v=1',
          maxBytes: 65_536,
          scope: 'global',
        }],
        transcriptActivities: [{
          id: 'import-progress-card',
          resourceId: 'import-progress',
        }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'transcriptActivities', 0, 'resourceId'],
      })],
    });
  });

  it('admits a Resource-backed declarative Session-info section', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{
          id: 'open-details',
          title: 'Open details',
          scopes: ['session'],
          surfaces: ['ui'],
          placementBindings: ['rowAction'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
        resources: [{
          id: 'session-overview',
          source: 'dynamic',
          kind: 'config',
          contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
          maxBytes: 65_536,
          scope: 'session',
        }],
        sessionInfoSections: [{
          id: 'overview',
          resourceId: 'session-overview',
          actions: ['open-details'],
        }],
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      manifest: { contributes: { sessionInfoSections: [{
        id: 'overview',
        resourceId: 'session-overview',
        actions: ['open-details'],
      }] } },
    });
  });

  it('rejects a Session-info section backed by a non-declarative Resource', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{
          id: 'session-overview',
          source: 'dynamic',
          kind: 'config',
          contentType: 'application/json',
          maxBytes: 65_536,
          scope: 'session',
        }],
        sessionInfoSections: [{ id: 'overview', resourceId: 'session-overview' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'sessionInfoSections', 0, 'resourceId'],
      })],
    });
  });

  describe('composer control state Resource admission', () => {
    function composerControlManifest(resource: Record<string, unknown>): Record<string, unknown> {
      return manifest({
        contributes: {
          actions: [{
            id: 'open-picker',
            title: 'Open picker',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['rowAction'],
            dangerLevel: 'safe',
            execution: { target: 'daemon' },
          }],
          resources: [resource],
          composerControls: [{
            id: 'model-control',
            label: 'Model',
            icon: 'settings',
            state: { resource: 'control-state' },
            interaction: { kind: 'action', action: 'open-picker' },
          }],
        },
      });
    }

    it('admits a bounded, exactly typed dynamic Resource', () => {
      const result = ingestPluginManifestV2(composerControlManifest({
        id: 'control-state',
        source: 'dynamic',
        kind: 'config',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
        scope: 'session',
      }));

      expect(result).toMatchObject({ ok: true });
    });

    it('rejects a composer control state Resource that omits maxBytes', () => {
      const result = ingestPluginManifestV2(composerControlManifest({
        id: 'control-state',
        source: 'dynamic',
        kind: 'config',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        scope: 'session',
      }));

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['contributes', 'composerControls', 0, 'state', 'resource'],
        })],
      });
    });

    it('rejects a composer control state Resource above the purpose-specific ceiling', () => {
      const result = ingestPluginManifestV2(composerControlManifest({
        id: 'control-state',
        source: 'dynamic',
        kind: 'config',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1 + 1,
        scope: 'session',
      }));

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['contributes', 'composerControls', 0, 'state', 'resource'],
        })],
      });
    });

    it('rejects a composer control state Resource that is not the exact V1 content type', () => {
      const result = ingestPluginManifestV2(composerControlManifest({
        id: 'control-state',
        source: 'dynamic',
        kind: 'config',
        contentType: 'application/json',
        maxBytes: MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1,
        scope: 'session',
      }));

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['contributes', 'composerControls', 0, 'state', 'resource'],
        })],
      });
    });

    it('rejects a packaged Resource bound as composer control state', () => {
      const result = ingestPluginManifestV2(composerControlManifest({
        id: 'control-state',
        source: 'packaged',
        kind: 'config',
        path: './state.json',
        contentType: COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
      }));

      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['contributes', 'composerControls', 0, 'state', 'resource'],
        })],
      });
    });

    it('bounds the ceiling above the largest natural schema-valid control state document', () => {
      const astral = '\u{1F600}'.repeat(128);
      const largest = {
        visible: true,
        enabled: true,
        selected: true,
        count: Number.MAX_SAFE_INTEGER,
        icon: 'settings',
        label: astral,
        accessibilityLabel: `${astral}${astral}`,
        unavailableReason: `${astral}${astral}`,
        selectedChoiceIds: Array.from(
          { length: MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 },
          (_unused, index) => `${astral.slice(0, 250)}${index}`,
        ),
      };
      expect(ComposerControlStateV1Schema.safeParse(largest).success).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(largest)).byteLength)
        .toBeLessThanOrEqual(MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1);
    });
  });

  it('requires every packaged Action to declare its execution target', () => {
    const actionWithoutExecution = {
      id: 'summarize',
      title: 'Summarize',
      scopes: ['session'],
      surfaces: ['cli'],
      dangerLevel: 'safe',
    };
    const ingested = ingestPluginManifestV2(manifest({
      contributes: { actions: [actionWithoutExecution] },
    }));

    expect(ingested).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'plugin_manifest_invalid' }),
      ]),
    });

    // A declared target remains strict: host is private to canonical host
    // ActionSpecs, client requires its exact artifact tuple, and daemon cannot
    // carry client-only fields.
    for (const execution of [
      { target: 'host' },
      { target: 'client' },
      { target: 'daemon', client: { artifactId: 'a', modulePath: './a', exportName: 'a' } },
    ]) {
      expect(ingestPluginManifestV2(manifest({
        contributes: { actions: [{ ...actionWithoutExecution, execution }] },
      })).ok).toBe(false);
    }
  });

  it('accepts target entrypoints/hostAccess and rejects retired manifest owners', () => {
    const target = manifest({
      entrypoints: { daemon: './dist/plugin.js', development: './src/plugin.ts' },
      activation: { events: [{ kind: 'startup' }] },
      hostAccess: { required: [], optional: [] },
    });
    expect(ingestPluginManifestV2(target).ok).toBe(true);

    for (const retired of [
      { uses: [] },
      { declares: { capabilities: [] } },
      { permissions: { required: [] } },
      { source: { kind: 'path', path: '/tmp/plugin' } },
      { activationEvents: ['startup'] },
      { activation: { events: ['startup'] } },
      { entrypoints: { main: './dist/plugin.js' } },
    ]) {
      expect(ingestPluginManifestV2({ ...target, ...retired })).toEqual({
        ok: false,
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'plugin_manifest_invalid' })]),
      });
    }
  });

  it('enforces exact semver ranges and every strict host-access branch', () => {
    const required = [
      { id: 'network', capability: 'network', reason: 'Network', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }], methods: ['GET'] } },
      { id: 'network-client', capability: 'network.client', reason: 'Client realtime', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }], transports: ['websocket'] } },
      { id: 'filesystem', capability: 'filesystem', reason: 'Files', scope: { locations: [{ root: 'workspace', pathPrefix: 'src' }], access: ['read'] } },
      { id: 'process', capability: 'process', reason: 'Process', scope: { executables: [{ kind: 'systemTool', id: 'tool' }], envKeys: ['PATH'] } },
      { id: 'environment', capability: 'environment', reason: 'Environment', scope: { keys: ['HAPPIER_PROFILE'] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      { id: 'sessions', capability: 'sessions', reason: 'Sessions', scope: { access: ['read'] } },
      { id: 'terminal', capability: 'terminal', reason: 'Terminal', scope: { operations: ['open'] } },
      { id: 'browser', capability: 'browser', reason: 'Browser', scope: { operations: ['read'], origins: ['http://localhost:3000'] } },
      { id: 'clipboard', capability: 'clipboard', reason: 'Clipboard', scope: { access: ['write'] } },
      { id: 'links', capability: 'externalLinks', reason: 'Links', scope: { origins: ['https://example.test'] } },
      { id: 'storage', capability: 'storage.account', reason: 'Storage', scope: { enabled: true } },
      { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: ['server'], operations: ['callTools'] } },
    ];
    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required },
      contributes: {
        connectedAccountDescriptors: [connectedAccountDescriptor('account')],
        systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
        mcp: { servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }] },
      },
    })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({ engines: { happier: 'banana1.2.3' } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ engines: { happier: '*' } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ version: '1.0.0-01' })).ok).toBe(false);
    expect(required).toHaveLength(13);
    expect(PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => entry.capability)).toEqual(required.map((entry) => entry.capability));
    expect(PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => [
      entry.capability,
      entry.authorizationClass,
    ])).toEqual([
      ['network', 'cooperativeDisclosure'],
      ['network.client', 'cooperativeDisclosure'],
      ['filesystem', 'cooperativeDisclosure'],
      ['process', 'cooperativeDisclosure'],
      ['environment', 'cooperativeDisclosure'],
      ['connectedAccounts', 'hostResourceSelection'],
      ['sessions', 'hostResourceSelection'],
      ['terminal', 'presentIntentOrOs'],
      ['browser', 'presentIntentOrOs'],
      ['clipboard', 'presentIntentOrOs'],
      ['externalLinks', 'presentIntentOrOs'],
      ['storage.account', 'hostResourceSelection'],
      ['mcp', 'hostResourceSelection'],
    ]);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'ftp://example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://user:pass@example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ ...required[0], scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }, { kind: 'fixedOrigin', origin: 'https://example.test' }] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ id: 'intercept', capability: 'network.intercept', reason: 'Intercept', scope: { origins: ['https://example.test/path'] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ id: 'bad-env', capability: 'environment', reason: 'Bad', scope: { keys: ['*'] } }] } })).ok).toBe(false);
    expect(ingestPluginManifestV2(manifest({ hostAccess: { required: [{ id: 'bare-process', capability: 'process', reason: 'Bad', scope: { executables: ['tool'] } }] } })).ok).toBe(false);
  });

  it('allows only independently selectable host-owned resources in optional host access', () => {
    const requests = [
      { id: 'network', capability: 'network', reason: 'Network', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } },
      { id: 'network-client', capability: 'network.client', reason: 'Client realtime', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }], transports: ['websocket'] } },
      { id: 'filesystem', capability: 'filesystem', reason: 'Files', scope: { locations: [{ root: 'workspace' }], access: ['read'] } },
      { id: 'process', capability: 'process', reason: 'Process', scope: { executables: [{ kind: 'systemTool', id: 'tool' }] } },
      { id: 'environment', capability: 'environment', reason: 'Environment', scope: { keys: ['HAPPIER_PROFILE'] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      { id: 'sessions', capability: 'sessions', reason: 'Sessions', scope: { access: ['read'] } },
      { id: 'terminal', capability: 'terminal', reason: 'Terminal', scope: { operations: ['open'] } },
      { id: 'browser', capability: 'browser', reason: 'Browser', scope: { operations: ['read'] } },
      { id: 'clipboard', capability: 'clipboard', reason: 'Clipboard', scope: { access: ['write'] } },
      { id: 'links', capability: 'externalLinks', reason: 'Links', scope: { origins: ['https://example.test'] } },
      { id: 'storage', capability: 'storage.account', reason: 'Storage', scope: { enabled: true } },
      { id: 'mcp', capability: 'mcp', reason: 'MCP', scope: { serverRefs: ['server'], operations: ['callTools'] } },
    ];
    const selectableCapabilities = new Set(['connectedAccounts', 'sessions', 'storage.account', 'mcp']);
    const selectable = requests.filter((request) => selectableCapabilities.has(request.capability));
    const disclosureOnly = requests.filter((request) => !selectableCapabilities.has(request.capability));

    expect(PluginManifestHostAccessV2Schema.safeParse({ required: requests, optional: [] }).success).toBe(true);
    expect(PluginManifestHostAccessV2Schema.safeParse({ required: [], optional: selectable }).success).toBe(true);
    for (const request of disclosureOnly) {
      expect(PluginManifestHostAccessV2Schema.safeParse({ required: [], optional: [request] }).success).toBe(false);
    }
  });

  it('rejects removed contribution-family owners instead of silently preserving them', () => {
    for (const family of [
      'uiDescriptors', 'uiTranslations', 'surfacePlacements', 'hostedWeb', 'embeddedWebBundles',
      'reactNativeBundles', 'uiArtifacts', 'agentSettings', 'lifecycleHandlers',
    ]) {
      const result = ingestPluginManifestV2(manifest({ contributes: { [family]: [] } }));
      expect(result).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ path: ['contributes', family] })],
      });
    }
  });

  it('produces the same normalized record from UTF-8 bytes and a bundled object', () => {
    const input = manifest();
    const fromBytes = ingestPluginManifestV2(Buffer.from(JSON.stringify(input), 'utf8'));
    const fromObject = ingestPluginManifestV2(input);

    expect(fromBytes).toEqual(fromObject);
    expect(fromBytes.ok).toBe(true);
  });

  it('rejects malformed UTF-8 at the canonical byte-ingress owner', () => {
    const bytes = Buffer.concat([
      Buffer.from('{"schemaVersion":2,"id":"com.acme.plugin","version":"1.0.0","displayName":"'),
      Buffer.from([0xff]),
      Buffer.from('","engines":{"happier":"^0.2.0"},"runtime":{"apiVersion":1},"contributes":{}}'),
    ]);

    expect(ingestPluginManifestV2(bytes)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
  });

  it('materializes every catalog family default when contributes is omitted', () => {
    const input = manifest();
    delete input.contributes;
    const result = ingestPluginManifestV2(input);
    expect(result).toEqual({ ok: true, manifest: expect.any(Object) });
    if (result.ok) {
      for (const entry of PLUGIN_CONTRIBUTION_CATALOG_V2) {
        expect(entry.readEntries(result.manifest.contributes as Readonly<Record<string, unknown>>), entry.manifestKey).toEqual([]);
      }
    }
  });

  it('rejects non-JSON objects without traversing accessors or dropping symbol fields', () => {
    const cyclic = manifest();
    cyclic.self = cyclic;
    expect(ingestPluginManifestV2(cyclic)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
    expect(ingestPluginManifestV2({ ...manifest(), value: 1n })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
    for (const value of [undefined, () => undefined, Symbol('invalid'), Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(ingestPluginManifestV2({ ...manifest(), metadata: { invalid: value } })).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
      });
    }

    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, 'derived', {
      enumerable: true,
      get: () => 'not plain JSON',
    });
    const symbolMetadata = { ordinary: 'preserved' };
    Object.defineProperty(symbolMetadata, Symbol('hidden'), {
      enumerable: true,
      value: 'not JSON',
    });
    for (const metadata of [accessorMetadata, symbolMetadata]) {
      expect(ingestPluginManifestV2(manifest({ metadata }))).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
      });
    }
  });

  it('accepts non-enumerable symbol-keyed host brands that JSON output cannot carry', () => {
    const brand = Symbol.for('happier.test.manifestBrand.v1');
    const nested = { ordinary: 'preserved' };
    Object.defineProperty(nested, brand, { value: { refs: [] }, enumerable: false });
    const brandedList: unknown[] = ['first'];
    Object.defineProperty(brandedList, brand, { value: 'sidecar', enumerable: false });
    const input = manifest({ metadata: { nested, brandedList } });
    Object.defineProperty(input, brand, { value: 'sidecar', enumerable: false });

    const result = ingestPluginManifestV2(input);

    expect(result).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        metadata: { nested: { ordinary: 'preserved' }, brandedList: ['first'] },
      }),
    });
  });

  it('still rejects an enumerable symbol key on a nested manifest array', () => {
    const brandedList: unknown[] = ['first'];
    Object.defineProperty(brandedList, Symbol('visible'), { value: 'lost', enumerable: true });

    expect(ingestPluginManifestV2(manifest({ metadata: { brandedList } }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
  });

  it('rejects an object with a non-enumerable own toJSON without invoking it', () => {
    const input = manifest();
    let calls = 0;
    Object.defineProperty(input, 'toJSON', {
      enumerable: false,
      value: () => {
        calls += 1;
        return manifest();
      },
    });

    const result = ingestPluginManifestV2(input);

    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
  });

  it('rejects an array with a non-enumerable own toJSON without invoking it', () => {
    const input: unknown[] = [];
    let calls = 0;
    Object.defineProperty(input, 'toJSON', {
      enumerable: false,
      value: () => {
        calls += 1;
        return manifest();
      },
    });

    const result = ingestPluginManifestV2(input);

    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
  });

  it('rejects an array with an inherited toJSON without invoking it', () => {
    const input: unknown[] = [];
    let calls = 0;
    Object.setPrototypeOf(input, {
      toJSON: () => {
        calls += 1;
        return manifest();
      },
    });

    const result = ingestPluginManifestV2(input);

    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_json' })],
    });
  });

  it('does not confuse an author-controlled ok key with an internal decode result', () => {
    expect(ingestPluginManifestV2({ ...manifest(), ok: false })).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid', path: ['ok'] })],
    });
  });

  it('accepts shared acyclic JSON subobjects with byte parity to serialization', () => {
    const shared = { note: 'shared' };
    const input = manifest({ metadata: { left: shared, right: shared } });
    expect(ingestPluginManifestV2(input)).toEqual(ingestPluginManifestV2(JSON.stringify(input)));
    expect(ingestPluginManifestV2(input).ok).toBe(true);
  });

  it('returns a typed invalid diagnostic instead of throwing on deeply nested metadata', () => {
    let result: ReturnType<typeof ingestPluginManifestV2> | undefined;
    expect(() => {
      result = ingestPluginManifestV2(serializedManifestWithMetadataDepth(5_000));
    }).not.toThrow();
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid' })],
    });
  });

  it('rejects unknown manifest and contribution-family fields with paths', () => {
    const root = ingestPluginManifestV2(manifest({ futureBehavior: true }));
    const family = ingestPluginManifestV2(manifest({ contributes: { futureFamily: [] } }));

    expect(root).toEqual({ ok: false, diagnostics: [expect.objectContaining({ path: ['futureBehavior'] })] });
    expect(family).toEqual({ ok: false, diagnostics: [expect.objectContaining({ path: ['contributes', 'futureFamily'] })] });
  });

  it('rejects duplicate local ids across contribution families', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'shared', kind: 'asset', path: 'shared.txt', contentType: 'text/plain' }],
        actions: [{ id: 'shared', title: 'Shared', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' } }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_duplicate_contribution_id' })],
    });
  });

  it('does not place translation locales in the contribution local-id namespace', () => {
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'en', kind: 'asset', path: 'en.json', contentType: 'application/json' }],
        ui: { translations: [{ locale: 'en', messages: { title: 'Title' } }] },
      },
    })).ok).toBe(true);
  });

  it('enforces the catalog local-id grammar for every identified family', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: { resources: [{ id: 'legacy.dotted', kind: 'asset', path: 'asset.txt', contentType: 'text/plain' }] },
    }));
    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid_contribution_id' })],
    });
  });

  it('admits only a same-plugin packaged PNG asset as an optional brand icon', () => {
    const valid = manifest({
      brand: { iconResourceId: 'brand-icon' },
      contributes: {
        resources: [{
          id: 'brand-icon',
          kind: 'asset',
          path: 'assets/brand.png',
          contentType: 'image/png',
        }],
      },
    });

    expect(ingestPluginManifestV2(valid)).toEqual({
      ok: true,
      manifest: expect.objectContaining({ brand: { iconResourceId: 'brand-icon' } }),
    });

    expect(ingestPluginManifestV2(manifest({
      brand: { iconResourceId: 'brand-icon' },
      contributes: { resources: [] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['brand', 'iconResourceId'],
      })],
    });

    for (const resource of [
      { id: 'brand-icon', source: 'dynamic', kind: 'asset', contentType: 'image/png' },
      { id: 'brand-icon', kind: 'prompt', path: 'assets/brand.png', contentType: 'image/png' },
      { id: 'brand-icon', kind: 'asset', path: 'assets/brand.svg', contentType: 'image/svg+xml' },
    ]) {
      expect(ingestPluginManifestV2(manifest({
        brand: { iconResourceId: 'brand-icon' },
        contributes: { resources: [resource] },
      }))).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['brand', 'iconResourceId'],
        })],
      });
    }

    expect(ingestPluginManifestV2(manifest({
      brand: { iconResourceId: { pluginId: 'other.plugin', localId: 'brand-icon' } },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ path: ['brand', 'iconResourceId'] })],
    });
  });

  it('rejects dangling and wrong-family references', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        tools: [{ id: 'tool', title: 'Tool', name: 'tool', action: 'missing' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });

    const uiRenderer = {
      id: 'declared-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'Declared' },
    };
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: {
          renderers: [uiRenderer],
          views: [{
            id: 'view',
            container: 'appPage',
            target: { kind: 'app' },
            renderer: 'missing-renderer',
          }],
        },
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'ui', 'views', 0, 'renderer'],
      })],
    });

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: {
          renderers: [uiRenderer],
          settingsPages: [{
            id: 'settings-page',
            group: { kind: 'plugin', localId: 'declared-renderer' },
            title: 'Settings',
            renderer: 'declared-renderer',
          }],
        },
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_wrong_family_reference',
        path: ['contributes', 'ui', 'settingsPages', 0, 'group', 'localId'],
      })],
    });
  });

  it('resolves Composer control attachment references through the canonical manifest catalog', () => {
    const dangling = ingestPluginManifestV2(manifest({
      contributes: {
        composerControls: [{
          id: 'issue-control',
          label: 'Issue',
          icon: 'error',
          interaction: {
            kind: 'attachmentPicker',
            attachment: 'missing-issue',
            presentation: 'popover',
            layout: 'content',
          },
        }],
      },
    }));
    expect(dangling).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'composerControls', 0, 'interaction', 'attachment'],
      })],
    });

    const wrongFamily = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{
          id: 'issue',
          title: 'Issue',
          scopes: ['session'],
          surfaces: ['plugin'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
        composerControls: [{
          id: 'issue-control',
          label: 'Issue',
          icon: 'error',
          interaction: {
            kind: 'attachmentPicker',
            attachment: 'issue',
            presentation: 'popover',
            layout: 'content',
          },
        }],
      },
    }));
    expect(wrongFamily).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_wrong_family_reference',
        path: ['contributes', 'composerControls', 0, 'interaction', 'attachment'],
      })],
    });
  });

  it('rejects declarative item and collection command references at their exact authored paths', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{
          id: 'not-a-destination',
          title: 'Action only',
          scopes: ['session'],
          surfaces: ['ui'],
          placementBindings: ['rowAction'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
        ui: {
          renderers: [{
            id: 'task-list',
            kind: 'declarative',
            root: {
              kind: 'stack',
              children: [{
                kind: 'item',
                title: 'Item',
                action: 'missing-item-action',
              }, {
                kind: 'collectionList',
                source: { collectionId: 'tasks', uiQueryId: 'open-tasks' },
                projection: { titleField: { field: 'title', kind: 'string' } },
                primaryCommand: { kind: 'action', action: 'missing-primary-action' },
                secondaryCommands: [
                  { kind: 'action', action: 'missing-secondary-action' },
                  { kind: 'openSurface', destination: 'not-a-destination' },
                ],
              }],
            },
          }],
        },
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 0, 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 1, 'primaryCommand', 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 1, 'secondaryCommands', 0, 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_wrong_family_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 1, 'secondaryCommands', 1, 'destination'],
        }),
      ]),
    });
  });

  it('resolves exact qualified openSurface destinations for Session/page chrome and collection commands', () => {
    const provider = ingestPluginManifestV2(manifest({
      id: 'com.acme.provider',
      contributes: {
        ui: {
          renderers: [{
            id: 'provider-renderer',
            kind: 'declarative',
            root: { kind: 'text', text: 'Provider repair' },
          }],
          views: [{
            id: 'repair-view',
            container: 'appPage',
            target: { kind: 'app' },
            renderer: 'provider-renderer',
          }],
          settingsPages: [{
            id: 'repair-settings',
            group: { kind: 'host', id: 'general' },
            title: 'Repair settings',
            renderer: 'provider-renderer',
          }],
        },
      },
    }));
    const caller = ingestPluginManifestV2(manifest({
      id: 'com.acme.caller',
      contributes: {
        sessionHeaderActions: [{
          id: 'open-provider',
          title: 'Open provider',
          command: {
            kind: 'openSurface',
            destination: { pluginId: 'com.acme.provider', localId: 'repair-view' },
          },
        }],
        ui: {
          renderers: [{
            id: 'caller-renderer',
            kind: 'declarative',
            root: {
              kind: 'collectionList',
              source: { collectionId: 'tasks', uiQueryId: 'open-tasks' },
              projection: { titleField: { field: 'title', kind: 'string' } },
              primaryCommand: {
                kind: 'openSurface',
                destination: { pluginId: 'com.acme.provider', localId: 'repair-view' },
              },
            },
          }],
          views: [{
            id: 'caller-page',
            container: 'appPage',
            target: { kind: 'app' },
            renderer: 'caller-renderer',
            headerActions: [{
              id: 'open-settings',
              title: 'Open settings',
              command: {
                kind: 'openSurface',
                destination: { pluginId: 'com.acme.provider', localId: 'repair-settings' },
              },
            }],
          }],
        },
      },
    }));

    expect(provider.ok).toBe(true);
    expect(caller.ok).toBe(true);
    if (!provider.ok || !caller.ok) return;

    expect(resolvePluginManifestSetReferencesV2([provider.manifest, caller.manifest])).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([caller.manifest])).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'sessionHeaderActions', 0, 'command', 'destination'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'views', 0, 'headerActions', 0, 'command', 'destination'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'primaryCommand', 'destination'],
        }),
      ]),
    });
  });

  it('rejects qualified cross-plugin declarative Actions while preserving exact openSurface destinations', () => {
    const provider = ingestPluginManifestV2(manifest({
      id: 'com.acme.provider',
      contributes: {
        actions: [{
          id: 'repair',
          title: 'Repair',
          scopes: ['session'],
          surfaces: ['ui'],
          placementBindings: ['rowAction'],
          dangerLevel: 'safe',
          execution: { target: 'daemon' },
        }],
        ui: {
          renderers: [{
            id: 'provider-renderer',
            kind: 'declarative',
            root: { kind: 'text', text: 'Provider repair' },
          }],
          views: [{
            id: 'repair-view',
            container: 'appPage',
            target: { kind: 'app' },
            renderer: 'provider-renderer',
          }],
        },
      },
    }));
    const openSurfaceCaller = ingestPluginManifestV2(manifest({
      id: 'com.acme.open-caller',
      contributes: {
        ui: {
          renderers: [{
            id: 'caller-renderer',
            kind: 'declarative',
            root: {
              kind: 'collectionList',
              source: { collectionId: 'tasks', uiQueryId: 'open-tasks' },
              projection: { titleField: { field: 'title', kind: 'string' } },
              primaryCommand: {
                kind: 'openSurface',
                destination: { pluginId: 'com.acme.provider', localId: 'repair-view' },
              },
            },
          }],
        },
      },
    }));
    const actionCaller = ingestPluginManifestV2(manifest({
      id: 'com.acme.action-caller',
      contributes: {
        ui: {
          renderers: [{
            id: 'caller-renderer',
            kind: 'declarative',
            root: {
              kind: 'stack',
              children: [{
                kind: 'action',
                action: { pluginId: 'com.acme.provider', localId: 'repair' },
                label: 'Repair',
              }, {
                kind: 'item',
                title: 'Repair item',
                action: { pluginId: 'com.acme.provider', localId: 'repair' },
              }, {
                kind: 'collectionList',
                source: { collectionId: 'tasks', uiQueryId: 'open-tasks' },
                projection: { titleField: { field: 'title', kind: 'string' } },
                primaryCommand: {
                  kind: 'action',
                  action: { pluginId: 'com.acme.provider', localId: 'repair' },
                },
                secondaryCommands: [{
                  kind: 'action',
                  action: { pluginId: 'com.acme.provider', localId: 'repair' },
                }],
              }],
            },
          }],
        },
      },
    }));

    expect(provider.ok).toBe(true);
    expect(openSurfaceCaller.ok).toBe(true);
    if (provider.ok && openSurfaceCaller.ok) {
      expect(resolvePluginManifestSetReferencesV2([provider.manifest, openSurfaceCaller.manifest])).toEqual({ ok: true });
    }
    expect(actionCaller).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 0, 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 1, 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 2, 'primaryCommand', 'action'],
        }),
        expect.objectContaining({
          code: 'plugin_manifest_dangling_reference',
          path: ['contributes', 'ui', 'renderers', 0, 'root', 'children', 2, 'secondaryCommands', 0, 'action'],
        }),
      ]),
    });
  });

  it('binds an openable-content viewer to one same-plugin direct UI view', () => {
    const renderer = {
      id: 'viewer-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'Viewer' },
    };
    const view = {
      id: 'viewer-view',
      container: 'detailsTab',
      target: { kind: 'session' },
      renderer: 'viewer-renderer',
      title: 'Viewer',
    };
    const viewer = {
      id: 'viewer',
      destination: 'viewer-view',
      contentClasses: ['text'],
      mimeTypes: ['text/plain'],
    };

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: { renderers: [renderer], views: [view] },
        openableContentViewers: [viewer],
      },
    }))).toEqual({ ok: true, manifest: expect.any(Object) });

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: { renderers: [renderer], views: [{ ...view, instancePolicy: 'multiple' }] },
        openableContentViewers: [viewer],
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'openableContentViewers', 0, 'destination'],
      })],
    });

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: { renderers: [renderer], views: [view] },
        openableContentViewers: [{ ...viewer, destination: 'missing-view' }],
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'openableContentViewers', 0, 'destination'],
      })],
    });

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ui: { renderers: [renderer], views: [view] },
        openableContentViewers: [{ ...viewer, destination: 'viewer-renderer' }],
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_wrong_family_reference',
        path: ['contributes', 'openableContentViewers', 0, 'destination'],
      })],
    });
  });

  it('binds a declarative document source to the canonical local Resource family', () => {
    const renderer = {
      id: 'live-panel',
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: { kind: 'resource', resourceId: 'live-document' },
    };
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{
          id: 'live-document',
          source: 'dynamic',
          kind: 'config',
          contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
          maxBytes: MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
        }],
        ui: { renderers: [renderer] },
      },
    }))).toEqual({ ok: true, manifest: expect.any(Object) });

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{
          id: 'live-document', title: 'Not a Resource', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' },
        }],
        ui: { renderers: [renderer] },
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_wrong_family_reference',
        path: ['contributes', 'ui', 'renderers', 0, 'documentSource', 'resourceId'],
      })],
    });
  });

  it('requires a declarative document Resource to declare a UI-thread byte ceiling', () => {
    const renderer = {
      id: 'live-panel',
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: { kind: 'resource', resourceId: 'live-document' },
    };
    const withMaxBytes = (maxBytes?: number) => manifest({
      contributes: {
        resources: [{
          id: 'live-document',
          source: 'dynamic',
          kind: 'config',
          contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }],
        ui: { renderers: [renderer] },
      },
    });

    // Independent literal: the ceiling is a product bound derived from the
    // approved 256 KiB aggregate string/key budget, not whatever the constant
    // happens to say, so a silent widening fails here.
    expect(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1).toBe(512 * 1024);
    expect(ingestPluginManifestV2(withMaxBytes())).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', 0, 'documentSource', 'resourceId'],
      })],
    });
    expect(ingestPluginManifestV2(
      withMaxBytes(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1 + 1),
    )).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', 0, 'documentSource', 'resourceId'],
      })],
    });
    expect(ingestPluginManifestV2(
      withMaxBytes(MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1),
    )).toEqual({ ok: true, manifest: expect.any(Object) });
  });

  it('rejects a packaged Resource as a live declarative document source', () => {
    const renderer = {
      id: 'live-panel',
      kind: 'declarative',
      root: { kind: 'text', text: 'Static first paint' },
      documentSource: { kind: 'resource', resourceId: 'packaged-document' },
    };

    expect(ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{
          id: 'packaged-document',
          kind: 'config',
          path: './document.json',
          contentType: 'application/json',
        }],
        ui: { renderers: [renderer] },
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'ui', 'renderers', 0, 'documentSource', 'resourceId'],
      })],
    });
  });

  it('rejects a dynamic document Resource whose declared content type is not the exact V1 document type', () => {
    for (const contentType of [
      'application/json',
      `${PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1};charset=utf-8`,
      'Application/vnd.happier.declarative-document+json;version=1',
    ]) {
      expect(ingestPluginManifestV2(manifest({
        contributes: {
          resources: [{
            id: 'live-document',
            source: 'dynamic',
            kind: 'config',
            contentType,
            maxBytes: MAX_PLUGIN_DECLARATIVE_DOCUMENT_RESOURCE_BYTES_V1,
          }],
          ui: {
            renderers: [{
              id: 'live-panel',
              kind: 'declarative',
              root: { kind: 'text', text: 'Static first paint' },
              documentSource: { kind: 'resource', resourceId: 'live-document' },
            }],
          },
        },
      }))).toEqual({
        ok: false,
        diagnostics: [expect.objectContaining({
          code: 'plugin_manifest_invalid',
          path: ['contributes', 'ui', 'renderers', 0, 'documentSource', 'resourceId'],
        })],
      });
    }
  });

  it('normalizes tools and commands as references to one declared action', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        actions: [{ id: 'summarize', title: 'Summarize', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' } }],
        tools: [{ id: 'summarize-tool', title: 'Summarize', name: 'summarize', action: 'summarize' }],
        commands: [{ id: 'summarize-command', title: 'Summarize', path: ['summarize'], action: 'summarize' }],
      },
    }));

    expect(result).toEqual({ ok: true, manifest: expect.any(Object) });
  });

  it('resolves action hostAccess request ids against the manifest disclosure owner', () => {
    const allowed = ingestPluginManifestV2(manifest({
      hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } }] },
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['api'] }] },
    }));
    expect(allowed.ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required: [{ id: 'api', capability: 'network', reason: 'API', scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] } }] },
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['api', 'api'] }] },
    })).ok).toBe(false);

    const dangling = ingestPluginManifestV2(manifest({
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' }, hostAccess: ['missing'] }] },
    }));
    expect(dangling).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference', path: ['contributes', 'actions', 0, 'hostAccess', 0] })],
    });
  });

  it('resolves hook hostAccess request ids against the same manifest disclosure owner', () => {
    const hook = {
      id: 'before-agent-request',
      on: 'agent.request.before',
      category: 'decision',
      scope: 'agent',
      executionKind: 'decide',
    };
    const request = {
      id: 'account',
      capability: 'connectedAccounts',
      reason: 'Use a selected account',
      scope: {
        serviceRefs: [{ pluginId: 'acme.accounts', localId: 'primary' }],
        operations: ['use'],
      },
    };

    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required: [request], optional: [] },
      contributes: { hooks: [{ ...hook, hostAccess: ['account'] }] },
    })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      contributes: { hooks: [{ ...hook, hostAccess: ['missing'] }] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'hooks', 0, 'hostAccess', 0],
      })],
    });
  });

  it('allows dynamic Resources to reference only Account storage HostAccess requests', () => {
    const resource = {
      id: 'account-status',
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/json',
    };
    const accountStorage = {
      id: 'account-storage',
      capability: 'storage.account',
      reason: 'Persist Account-scoped Resource state',
      scope: { enabled: true },
    };

    expect(ingestPluginManifestV2(manifest({
      hostAccess: { required: [accountStorage], optional: [] },
      contributes: { resources: [{ ...resource, hostAccess: ['account-storage'] }] },
    })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      contributes: { resources: [{ ...resource, hostAccess: ['missing'] }] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_dangling_reference',
        path: ['contributes', 'resources', 0, 'hostAccess', 0],
      })],
    });

    const wrongCapability = ingestPluginManifestV2(manifest({
      hostAccess: {
        required: [{
          id: 'api',
          capability: 'network',
          reason: 'Call an API',
          scope: { targets: [{ kind: 'fixedOrigin', origin: 'https://example.test' }] },
        }],
        optional: [],
      },
      contributes: { resources: [{ ...resource, hostAccess: ['api'] }] },
    }));
    expect(wrongCapability).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({
        code: 'plugin_manifest_invalid',
        path: ['contributes', 'resources', 0, 'hostAccess', 0],
      })],
    });
  });

  it('rejects a tool action reference that resolves to the wrong family or is dangling', () => {
    const result = ingestPluginManifestV2(manifest({
      contributes: {
        resources: [{ id: 'not-an-action', kind: 'asset', path: 'asset.txt', contentType: 'text/plain' }],
        tools: [{ id: 'tool', title: 'Tool', name: 'tool', action: 'not-an-action' }],
      },
    }));

    expect(result).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('resolves structured cross-plugin references against the complete manifest set', () => {
    const owner = ingestPluginManifestV2(manifest({
      id: 'com.acme.actions',
      contributes: { actions: [{ id: 'run', title: 'Run', scopes: ['session'], surfaces: ['cli'], placementBindings: ['primary'], dangerLevel: 'safe', execution: { target: 'daemon' } }] },
    }));
    const consumer = ingestPluginManifestV2(manifest({
      id: 'com.acme.tools',
      contributes: { tools: [{ id: 'runner', name: 'runner', title: 'Runner', action: { pluginId: 'com.acme.actions', localId: 'run' } }] },
    }));
    expect(owner.ok).toBe(true);
    expect(consumer.ok).toBe(true);
    if (!owner.ok || !consumer.ok) return;
    expect(resolvePluginManifestSetReferencesV2([owner.manifest, consumer.manifest])).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([consumer.manifest])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });

    const wrongOwner = ingestPluginManifestV2(manifest({
      id: 'com.acme.actions',
      contributes: { resources: [{ id: 'run', kind: 'asset', path: 'run.txt', contentType: 'text/plain' }] },
    }));
    expect(wrongOwner.ok).toBe(true);
    if (wrongOwner.ok) expect(resolvePluginManifestSetReferencesV2([wrongOwner.manifest, consumer.manifest])).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
  });

  it('validates host-access contribution references by family', () => {
    const contributes = {
      connectedAccountDescriptors: [connectedAccountDescriptor('account')],
      scmHostingProviders: [{ id: 'scm', title: 'SCM', kind: 'github', capabilities: ['detect'] }],
      systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
      managedDependencies: [managedDependency('managed')],
      mcp: {
        servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }],
        discoverySources: [{ id: 'discovery', title: 'Discovery' }],
      },
    };
    const required = [
      { id: 'account-origin', capability: 'network', reason: 'Account', scope: { targets: [{ kind: 'connectedAccountOrigin', service: 'account' }] } },
      { id: 'scm-origin', capability: 'network', reason: 'SCM', scope: { targets: [{ kind: 'scmProviderOrigin', provider: 'scm' }] } },
      { id: 'tool', capability: 'process', reason: 'Tool', scope: { executables: [{ kind: 'systemTool', id: 'tool' }] } },
      { id: 'managed', capability: 'process', reason: 'Managed', scope: { executables: [{ kind: 'managedDependency', id: 'managed' }] } },
      { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: ['account'], operations: ['use'] } },
      {
        id: 'mcp',
        capability: 'mcp',
        reason: 'MCP',
        scope: {
          serverRefs: ['server'],
          discoverySourceRefs: ['discovery'],
          operations: ['callTools', 'discover'],
        },
      },
    ];
    expect(ingestPluginManifestV2(manifest({ contributes, hostAccess: { required } })).ok).toBe(true);

    for (const request of required) {
      const dangling = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
      const serialized = JSON.stringify(dangling).replace(/"(account|scm|tool|managed|server|discovery)"/g, '"missing"');
      const expectedDiagnostics = request.capability === 'mcp'
        ? [
            expect.objectContaining({
              code: 'plugin_manifest_dangling_reference',
              path: ['hostAccess', 'required', 0, 'scope', 'serverRefs', 0],
            }),
            expect.objectContaining({
              code: 'plugin_manifest_dangling_reference',
              path: ['hostAccess', 'required', 0, 'scope', 'discoverySourceRefs', 0],
            }),
          ]
        : [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })];
      expect(ingestPluginManifestV2(manifest({ contributes, hostAccess: { required: [JSON.parse(serialized)] } }))).toEqual({
        ok: false,
        diagnostics: expectedDiagnostics,
      });
    }

    const wrongFamily = ingestPluginManifestV2(manifest({
      contributes: { ...contributes, resources: [{ id: 'wrong', kind: 'asset', path: 'wrong.txt', contentType: 'text/plain' }] },
      hostAccess: { required: [{ id: 'wrong', capability: 'process', reason: 'Wrong', scope: { executables: [{ kind: 'systemTool', id: 'wrong' }] } }] },
    }));
    expect(wrongFamily).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });

    const wrongMcpFamilyCases = [{
      id: 'wrong-server-family',
      scope: { serverRefs: ['discovery'], operations: ['listTools'] },
      paths: [['serverRefs', 0]],
    }, {
      id: 'wrong-discovery-family',
      scope: { discoverySourceRefs: ['server'], operations: ['discover'] },
      paths: [['discoverySourceRefs', 0]],
    }, {
      id: 'unrelated-mcp-family',
      scope: {
        serverRefs: ['asset'],
        discoverySourceRefs: ['asset'],
        operations: ['listTools', 'discover'],
      },
      paths: [['serverRefs', 0], ['discoverySourceRefs', 0]],
    }] as const;
    for (const testCase of wrongMcpFamilyCases) {
      const result = ingestPluginManifestV2(manifest({
        contributes: {
          ...contributes,
          resources: [{ id: 'asset', kind: 'asset', path: 'asset.txt', contentType: 'text/plain' }],
        },
        hostAccess: { required: [{
          id: testCase.id,
          capability: 'mcp',
          reason: 'Wrong MCP family',
          scope: testCase.scope,
        }] },
      }));
      expect(result).toEqual({
        ok: false,
        diagnostics: testCase.paths.map(([field, index]) => expect.objectContaining({
          code: 'plugin_manifest_wrong_family_reference',
          path: ['hostAccess', 'required', 0, 'scope', field, index],
        })),
      });
    }
  });

  it('validates managed Provider dependency and Connected Account references at manifest ingestion', () => {
    const provider = {
      v: 1,
      id: 'gateway',
      name: 'Gateway',
      kind: 'local',
      endpointTemplates: [{
        id: 'responses',
        protocol: 'openai-responses',
        baseUrl: 'http://127.0.0.1:3000',
        capabilities: {
          streaming: 'unknown', toolRoundTrips: 'unknown',
          statefulResponses: 'unknown', reasoningControls: 'unknown',
        },
      }],
      catalog: { source: 'manual', manualModelPolicy: 'allowed' },
      managedRuntime: {
        kind: 'managed',
        dependencies: ['runtime'],
        connectedAccounts: [{
          purpose: 'upstream',
          service: 'account',
          materializationKinds: ['httpHeaders'],
        }],
        endpointTemplateIds: ['responses'],
      },
    };
    const contributes = {
      providers: [provider],
      managedDependencies: [managedDependency('runtime')],
      connectedAccountDescriptors: [connectedAccountDescriptor('account')],
    };
    expect(ingestPluginManifestV2(manifest({ contributes })).ok).toBe(true);
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ...contributes,
        providers: [{
          ...provider,
          managedRuntime: { ...provider.managedRuntime, dependencies: ['account'] },
        }],
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_wrong_family_reference' })],
    });
    expect(ingestPluginManifestV2(manifest({
      contributes: {
        ...contributes,
        providers: [{
          ...provider,
          managedRuntime: {
            ...provider.managedRuntime,
            connectedAccounts: [{
              ...provider.managedRuntime.connectedAccounts[0],
              service: 'missing',
            }],
          },
        }],
      },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_dangling_reference' })],
    });
  });

  it('rejects public connected-account host adapter selection at manifest ingestion', () => {
    const descriptor = {
      ...connectedAccountDescriptor('account'),
      hostAdapter: 'githubOAuth',
    };

    expect(ingestPluginManifestV2(manifest({
      contributes: { connectedAccountDescriptors: [descriptor] },
    }))).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'plugin_manifest_invalid' })],
    });
  });

  it('resolves structured cross-plugin host-access references as one manifest batch', () => {
    const owner = ingestPluginManifestV2(manifest({
      id: 'com.acme.host-owner',
      contributes: {
        connectedAccountDescriptors: [connectedAccountDescriptor('account')],
        scmHostingProviders: [{ id: 'scm', title: 'SCM', kind: 'github', capabilities: ['detect'] }],
        systemTools: [{ id: 'tool', title: 'Tool', executableNames: ['tool'] }],
        managedDependencies: [managedDependency('managed')],
        mcp: {
          servers: [{ id: 'server', title: 'Server', kind: 'dynamic' }],
          discoverySources: [{ id: 'discovery', title: 'Discovery' }],
        },
      },
    }));
    const ref = (localId: string) => ({ pluginId: 'com.acme.host-owner', localId });
    const consumer = ingestPluginManifestV2(manifest({
      id: 'com.acme.host-consumer',
      hostAccess: { required: [
        { id: 'account', capability: 'network', reason: 'Account', scope: { targets: [{ kind: 'connectedAccountOrigin', service: ref('account') }] } },
        { id: 'scm', capability: 'network', reason: 'SCM', scope: { targets: [{ kind: 'scmProviderOrigin', provider: ref('scm') }] } },
        { id: 'tool', capability: 'process', reason: 'Tool', scope: { executables: [{ kind: 'systemTool', id: ref('tool') }] } },
        { id: 'managed', capability: 'process', reason: 'Managed', scope: { executables: [{ kind: 'managedDependency', id: ref('managed') }] } },
        { id: 'accounts', capability: 'connectedAccounts', reason: 'Accounts', scope: { serviceRefs: [ref('account')], operations: ['use'] } },
        {
          id: 'mcp',
          capability: 'mcp',
          reason: 'MCP',
          scope: {
            serverRefs: [ref('server')],
            discoverySourceRefs: [ref('discovery')],
            operations: ['callTools', 'discover'],
          },
        },
      ] },
    }));
    expect(owner.ok).toBe(true);
    expect(consumer.ok).toBe(true);
    if (!owner.ok || !consumer.ok) return;
    expect(resolvePluginManifestSetReferencesV2([owner.manifest, consumer.manifest])).toEqual({ ok: true });
    expect(resolvePluginManifestSetReferencesV2([consumer.manifest])).toEqual({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'plugin_manifest_dangling_reference', path: expect.arrayContaining(['hostAccess']) }),
      ]),
    });
  });

});
