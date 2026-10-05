import { describe, expect, it } from 'vitest';
import { PluginContributesV2Schema } from './v2.js';
import { PLUGIN_CONTRIBUTION_CATALOG_V2, derivePluginContributionRegistrationRights } from './catalog.js';
import { PluginActionContributionV2Schema } from '../actions/v2.js';

describe('declared plugin input types', () => {
  it('admits typed semantic selections at the existing Action schema boundary without weakening ordinary fields', () => {
    const action = { id: 'review', title: 'Review', description: 'Review', scopes: ['global'], surfaces: ['cli'],
      execution: { target: 'daemon' }, placementBindings: ['commandPalette'], dangerLevel: 'safe',
      inputSchema: { type: 'object', properties: { repository: { type: 'object', additionalProperties: true } },
        required: ['repository'], additionalProperties: false },
      inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select',
        inputType: { pluginId: 'com.acme.inputs', localId: 'repository' } }] } };
    expect(PluginActionContributionV2Schema.safeParse(action).success).toBe(true);
    expect(PluginActionContributionV2Schema.safeParse({ ...action,
      inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'select', options: [{ value: 'one', label: 'One' }] }] },
    }).success).toBe(false);
  });
  it('uses the incumbent family reference owner for Action, Workflow and widget input types', () => {
    const identity = { pluginId: 'com.acme.inputs', localId: 'repository' };
    for (const [family, declaration, path] of [
      ['actions', { inputHints: { fields: [{ inputType: identity }] } }, ['inputHints', 'fields', 0, 'inputType']],
      ['workflows', { definition: { inputs: [{ inputType: identity }] } }, ['definition', 'inputs', 0, 'inputType']],
      ['ui.views', { inputs: { fields: [{ inputType: identity }] } }, ['inputs', 'fields', 0, 'inputType']],
    ] as const) {
      expect(PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === family)?.extractReferences(declaration))
        .toContainEqual({ targetFamily: 'inputTypes', allowQualifiedCrossPlugin: true, allowQualifiedSamePlugin: true, reference: identity, path });
    }
  });
  it('admits a semantic schema and references existing executable Resource and picker leaves', () => {
    const descriptor = { id: 'repository', title: 'Repository', semantic: 'com.acme.repository',
      valueSchema: { type: 'string', minLength: 1 },
      options: { resource: 'repositories' },
      picker: 'repository-picker' };
    const parsed = PluginContributesV2Schema.safeParse({ inputTypes: [descriptor] });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({ inputTypes: [descriptor] });
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find((entry) => entry.manifestKey === 'inputTypes');
    expect(family).toMatchObject({ projectionFamily: 'inputTypes', allowedRuntimeRegistration: null });
    expect(family?.extractReferences(descriptor)).toEqual([
      { targetFamily: 'resources', reference: 'repositories', path: ['options', 'resource'] },
      { targetFamily: 'ui.renderers', reference: 'repository-picker', path: ['picker'] },
    ]);
    expect(derivePluginContributionRegistrationRights({ inputTypes: [descriptor] })).toEqual([]);
    expect(PluginContributesV2Schema.safeParse({ inputTypes: [{ ...descriptor, callback: 'another-owner' }] }).success).toBe(false);
    expect(PluginContributesV2Schema.safeParse({ inputTypes: [{ ...descriptor,
      valueSchema: { $ref: 'https://example.com/schema' } }] }).success).toBe(false);
  });
});
