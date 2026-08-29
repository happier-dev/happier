import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';

import { PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1 } from '../contributions/ui/surfaceRegistry.js';
import { createPluginManifestJsonSchemaV2 } from './jsonSchema.js';
import { PluginManifestV2Schema } from './v2.js';

const validManifest = {
  schemaVersion: 2,
  id: 'acme.schema',
  version: '0.1.0',
  displayName: 'Schema fixture',
  engines: { happier: '^0.2.0' },
  runtime: { apiVersion: 1 },
  entrypoints: {
    daemon: './dist/index.js',
    development: './src/index.ts',
  },
  contributes: {
    actions: [{
      id: 'hello',
      title: 'Hello',
      scopes: ['global'],
      surfaces: ['cli'],
      placementBindings: ['commandPalette'],
      dangerLevel: 'safe',
      execution: { target: 'daemon' },
    }],
  },
} as const;

const validateExternalManifest = new Ajv2020({
  strict: true,
  strictTuples: false,
  validateFormats: false,
}).compile(createPluginManifestJsonSchemaV2());

function targetForSlot(kind: string): Record<string, unknown> {
  switch (kind) {
    case 'app': return { kind };
    case 'session': return { kind };
    case 'project': return { kind };
    case 'browser': return { kind, browserViewIdPath: 'browserViewId' };
    case 'services': return { kind };
    default: throw new Error(`Unknown Registry target kind '${kind}'.`);
  }
}

function manifestForDestinationBindingSlot(slot: typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number]) {
  const renderer = {
    id: 'slot-renderer',
    kind: 'declarative',
    root: { kind: 'text', text: 'Slot' },
  } as const;
  if (slot.container === 'settingsPage') {
    return {
      ...validManifest,
      contributes: {
        ui: {
          renderers: [renderer],
          settingsPages: [{
            id: 'settings-slot',
            group: { kind: 'host', id: 'general' },
            title: 'Settings slot',
            renderer: renderer.id,
          }],
        },
      },
    };
  }
  return {
    ...validManifest,
    contributes: {
      ui: {
        renderers: [renderer],
        views: [{
          id: 'slot-view',
          container: slot.container,
          target: targetForSlot(slot.targetKind),
          renderer: renderer.id,
        }],
      },
    },
  };
}

describe('createPluginManifestJsonSchemaV2', () => {
  it('deterministically derives the external schema from the canonical host schema', () => {
    const first = createPluginManifestJsonSchemaV2();
    const second = createPluginManifestJsonSchemaV2();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://happier.dev/schemas/plugin-manifest-v2.json',
      title: 'Happier Plugin Manifest v2',
      type: 'object',
      additionalProperties: false,
    });

    expect(PluginManifestV2Schema.safeParse(validManifest).success).toBe(true);
    expect(validateExternalManifest(validManifest)).toBe(true);
  });

  it('rejects a host-rejected unknown behavior key at the generated schema boundary', () => {
    const invalid = { ...validManifest, uses: ['actions'] };

    expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
    expect(validateExternalManifest(invalid)).toBe(false);
  });

  it('keeps targeted protocol identifier admission aligned between the executable and generated manifest schemas', () => {
    const qualifiedProtocol = {
      ...validManifest,
      contributes: {
        pluginContributionPoints: [{
          id: 'providers',
          protocols: [{
            id: 'happier.channels/providers',
            version: 1,
            operations: {
              setup: {
                required: true,
                input: { kind: 'contributorDefined' },
                resultSchema: { type: 'object' },
                action: { surfaces: ['plugin'], dangerLevel: 'safe' },
              },
            },
          }],
        }],
      },
    };

    expect(PluginManifestV2Schema.safeParse(qualifiedProtocol).success).toBe(true);
    expect(validateExternalManifest(qualifiedProtocol)).toBe(true);

    for (const id of [
      'happier.channels.providers',
      'happier..channels/providers',
      'happier.channels//providers',
      'happier.channels/providers.',
    ]) {
      const malformed = {
        ...qualifiedProtocol,
        contributes: {
          pluginContributionPoints: [{
            ...qualifiedProtocol.contributes.pluginContributionPoints[0],
            protocols: [{
              ...qualifiedProtocol.contributes.pluginContributionPoints[0].protocols[0],
              id,
            }],
          }],
        },
      };
      expect(PluginManifestV2Schema.safeParse(malformed).success, id).toBe(false);
      expect(validateExternalManifest(malformed), id).toBe(false);
    }
  });

  it('keeps targeted operation-role keys aligned between manifest points and contributor bindings', () => {
    const operation = {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: { type: 'object' },
      action: { surfaces: ['plugin'], dangerLevel: 'safe' },
    };
    const valid = {
      ...validManifest,
      contributes: {
        pluginContributionPoints: [{
          id: 'providers',
          protocols: [{
            id: 'happier.channels/providers',
            version: 1,
            operations: { connectionTest: operation },
          }],
        }],
        targetedPluginContributions: [{
          id: 'provider',
          target: { pluginId: 'happier.channels', pointId: 'providers' },
          protocol: { id: 'happier.channels/providers', version: 1 },
          operations: { connectionTest: 'arbitrary-action' },
        }],
      },
    };

    expect(PluginManifestV2Schema.safeParse(valid).success).toBe(true);
    expect(validateExternalManifest(valid)).toBe(true);

    for (const role of [
      'connection Test',
      'connection\\Test',
      '../connectionTest',
      'ConnectionTest',
      `a${'a'.repeat(256)}`,
    ]) {
      const invalidPoint = {
        ...valid,
        contributes: {
          ...valid.contributes,
          pluginContributionPoints: [{
            ...valid.contributes.pluginContributionPoints[0],
            protocols: [{
              ...valid.contributes.pluginContributionPoints[0].protocols[0],
              operations: { [role]: operation },
            }],
          }],
        },
      };
      const invalidContributor = {
        ...valid,
        contributes: {
          ...valid.contributes,
          targetedPluginContributions: [{
            ...valid.contributes.targetedPluginContributions[0],
            operations: { [role]: 'arbitrary-action' },
          }],
        },
      };

      expect(PluginManifestV2Schema.safeParse(invalidPoint).success, `point:${role}`).toBe(false);
      expect(validateExternalManifest(invalidPoint), `point:${role}`).toBe(false);
      expect(PluginManifestV2Schema.safeParse(invalidContributor).success, `contributor:${role}`).toBe(false);
      expect(validateExternalManifest(invalidContributor), `contributor:${role}`).toBe(false);
    }
  });

  it('structurally rejects arbitrary Action-form option sources at both author boundaries', () => {
    const invalid = {
      ...validManifest,
      contributes: {
        actions: [{
          ...validManifest.contributes.actions[0],
          inputHints: {
            fields: [{
              path: 'credentialRef',
              title: { fallback: 'Account' },
              widget: 'select',
              optionsSourceId: 'arbitrary.plugin.source',
            }],
          },
        }],
      },
    };

    expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
    expect(validateExternalManifest(invalid)).toBe(false);
  });

  it('places the Connected Account marker only on contributed Actions', () => {
    const invalidTool = {
      ...validManifest,
      contributes: {
        tools: [{
          id: 'connected-account-tool',
          name: 'connected_account_tool',
          title: 'Connected Account tool',
          action: 'run',
          inputHints: {
            fields: [{
              path: 'credentialRef',
              title: { fallback: 'Account' },
              widget: 'select',
              connectedAccountOptions: true,
            }],
          },
        }],
      },
    };

    expect(PluginManifestV2Schema.safeParse(invalidTool).success).toBe(false);
    expect(validateExternalManifest(invalidTool)).toBe(false);
  });

  it('admits only direct V2 UI destinations at both the canonical and generated manifest boundaries', () => {
    const direct = {
      ...validManifest,
      contributes: {
        ui: {
          renderers: [{
            id: 'session-summary',
            kind: 'declarative',
            root: { kind: 'text', text: 'Session summary' },
          }],
          views: [{
            id: 'session-summary-pane',
            container: 'rightPane',
            target: { kind: 'session' },
            renderer: 'session-summary',
          }],
        },
      },
    };
    const legacyBinding = {
      ...direct,
      contributes: {
        ui: {
          ...direct.contributes.ui,
          views: [{
            ...direct.contributes.ui.views[0],
            binding: { placement: 'session.preview' },
          }],
        },
      },
    };

    expect(PluginManifestV2Schema.safeParse(direct).success).toBe(true);
    expect(validateExternalManifest(direct)).toBe(true);
    expect(PluginManifestV2Schema.safeParse(legacyBinding).success).toBe(false);
    expect(validateExternalManifest(legacyBinding)).toBe(false);
  });

  it('derives every Registry binding row into the generated author schema and rejects an unsupported pair', () => {
    for (const slot of PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1) {
      const manifestForSlot = manifestForDestinationBindingSlot(slot);
      expect(PluginManifestV2Schema.safeParse(manifestForSlot).success, `${slot.container}/${slot.targetKind}`).toBe(true);
      expect(validateExternalManifest(manifestForSlot), `${slot.container}/${slot.targetKind}`).toBe(true);
    }

    const unsupported = {
      ...manifestForDestinationBindingSlot(PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[0]!),
      contributes: {
        ui: {
          renderers: [{
            id: 'slot-renderer',
            kind: 'declarative',
            root: { kind: 'text', text: 'Slot' },
          }],
          views: [{
            id: 'unsupported-view',
            container: 'appPage',
            target: { kind: 'session' },
            renderer: 'slot-renderer',
          }],
        },
      },
    };

    expect(PluginManifestV2Schema.safeParse(unsupported).success).toBe(false);
    expect(validateExternalManifest(unsupported)).toBe(false);
  });

  it.each(['rightPane', 'detailsPane', 'bottomPane'] as const)(
    'rejects the unsupported App whole-pane destination %s at both author boundaries',
    (container) => {
      const unsupported = {
        ...validManifest,
        contributes: {
          ui: {
            renderers: [{
              id: 'app-whole-pane-renderer',
              kind: 'declarative',
              root: { kind: 'text', text: 'Unsupported App whole pane' },
            }],
            views: [{
              id: 'app-whole-pane-view',
              container,
              target: { kind: 'app' },
              renderer: 'app-whole-pane-renderer',
            }],
          },
        },
      };

      expect(PluginManifestV2Schema.safeParse(unsupported).success).toBe(false);
      expect(validateExternalManifest(unsupported)).toBe(false);
    },
  );

  it('admits page header actions only on appPage at both author boundaries', () => {
    const headerAction = {
      id: 'refresh',
      title: 'Refresh',
      command: { kind: 'executeAction', action: 'refresh-activity' },
    };
    const manifestWithHeaderActions = (
      slot: typeof PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1[number],
    ) => {
      const base = manifestForDestinationBindingSlot(slot);
      return {
        ...base,
        contributes: {
          ui: {
            ...base.contributes.ui,
            views: base.contributes.ui.views!.map((view) => ({ ...view, headerActions: [headerAction] })),
          },
        },
      };
    };

    for (const slot of PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1) {
      if (slot.container === 'settingsPage') continue;
      const candidate = manifestWithHeaderActions(slot);
      const admitted = slot.container === 'appPage';
      const label = `${slot.container}/${slot.targetKind}`;
      expect(PluginManifestV2Schema.safeParse(candidate).success, label).toBe(admitted);
      // The generated authoring schema is the external editor's only source of
      // truth. It must reject exactly what the canonical parser rejects.
      expect(validateExternalManifest(candidate), label).toBe(admitted);
    }
  });

  it('keeps Settings pages out of ui.views at both canonical and generated boundaries', () => {
    const settingsPageAsView = {
      ...validManifest,
      contributes: {
        ui: {
          renderers: [{
            id: 'settings-renderer',
            kind: 'declarative',
            root: { kind: 'text', text: 'Settings' },
          }],
          views: [{
            id: 'settings',
            container: 'settingsPage',
            target: { kind: 'app' },
            renderer: 'settings-renderer',
          }],
        },
      },
    };

    expect(PluginManifestV2Schema.safeParse(settingsPageAsView).success).toBe(false);
    expect(validateExternalManifest(settingsPageAsView)).toBe(false);
  });

  it('rejects duplicate Connected Account materialization kinds at the generated schema boundary', () => {
    const invalid = {
      ...validManifest,
      hostAccess: {
        required: [{
          id: 'accounts',
          capability: 'connectedAccounts',
          reason: 'Use the selected account',
          scope: {
            serviceRefs: ['account'],
            operations: ['use'],
            materializationKinds: ['files', 'files'],
          },
        }],
        optional: [],
      },
      contributes: {
        actions: [{
          ...validManifest.contributes.actions[0],
          hostAccess: ['accounts'],
        }],
      },
    } as const;
    expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
    expect(validateExternalManifest(invalid)).toBe(false);
  });

  it("rejects Connected Account materialization kinds without 'use' at the generated schema boundary", () => {
    const invalid = {
      ...validManifest,
      hostAccess: {
        required: [{
          id: 'accounts',
          capability: 'connectedAccounts',
          reason: 'Select an account without credential disclosure',
          scope: {
            serviceRefs: ['account'],
            operations: ['select'],
            materializationKinds: ['files'],
          },
        }],
        optional: [],
      },
      contributes: {
        actions: [{
          ...validManifest.contributes.actions[0],
          hostAccess: ['accounts'],
        }],
      },
    } as const;
    expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
    expect(validateExternalManifest(invalid)).toBe(false);
  });

  it('rejects empty operation-specific MCP reference families at the generated schema boundary', () => {
    const mcpManifest = (scope: Readonly<Record<string, unknown>>) => ({
      ...validManifest,
      hostAccess: {
        required: [{
          id: 'mcp',
          capability: 'mcp',
          reason: 'Use selected MCP capabilities',
          scope,
        }],
        optional: [],
      },
    });

    for (const invalid of [
      mcpManifest({ serverRefs: [], operations: ['listTools'] }),
      mcpManifest({ discoverySourceRefs: [], operations: ['discover'] }),
    ]) {
      expect(PluginManifestV2Schema.safeParse(invalid).success).toBe(false);
      expect(validateExternalManifest(invalid)).toBe(false);
    }
  });

  it('keeps the published happier.dev schema synchronized with the canonical owner', async () => {
    const published = JSON.parse(await readFile(
      new URL('../../../../../apps/website/public/schemas/plugin-manifest-v2.json', import.meta.url),
      'utf8',
    )) as unknown;

    expect(published).toEqual(createPluginManifestJsonSchemaV2());
  });
});
