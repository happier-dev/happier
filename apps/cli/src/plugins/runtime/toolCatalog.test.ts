import { describe, expect, it } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { resolveDiscoveredPluginActionAvailability } from '@/agent/tools/happierTools/actionToolCatalog';
import { projectExecutablePluginToolCatalog, projectOccurrenceBoundExecutablePluginToolCatalog } from './toolCatalog';

const pluginId = 'acme.review.plugin';
const inputSchema = { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false };
const resultSchema = { type: 'object', properties: { completed: { type: 'boolean' } }, required: ['completed'], additionalProperties: false };

async function createFixture(visible = true) {
  return createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{
    manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
      id: 'review-start', title: { key: 'review.start', fallback: '{name} Review Start', params: { name: 'Acme' } },
      description: 'Review changes', scopes: ['global'], surfaces: ['agent', 'mcp', 'cli'],
      execution: { target: 'daemon' }, dangerLevel: 'safe', inputSchema, resultSchema,
      inputHints: { fields: [{ path: 'scope', title: 'Scope', widget: 'text' }] },
      tool: { name: 'acme_review_start', title: { key: 'review.tool.title', fallback: 'Review {scope}', params: { scope: 'changes' } }, description: 'Start a review',
        examples: { mcp: { argsExample: '{"scope":"diff"}' } },
        promptSnippet: 'Start a review when asked.', promptGuidelines: ['Choose the narrowest scope.'] },
      availability: { when: { fact: 'plugin.enabled', operator: 'equals', value: visible } },
    }] } }),
    files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("review-start", async () => ({ completed: true })); }' },
  }] });
}

describe('Action-owned executable tool catalog', () => {
  it('uses the canonical discoverable default and per-Action exposure override', () => {
    const request = { actionId: `${pluginId}/actions/review-start`, surface: 'mcp' as const,
      surfaces: { agent: true, mcp: true, cli: true, ui: false, voice: false, rpc: false, api: true, plugin: false } };
    expect(resolveDiscoveredPluginActionAvailability(request)).toMatchObject({ available: true,
      defaultToolExposureMode: 'discoverable_only', effectiveToolExposureMode: 'discoverable_only' });
    expect(resolveDiscoveredPluginActionAvailability({ ...request, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [request.actionId]: { toolExposureModes: { mcp: 'direct' } } } }) })).toMatchObject({
        available: true, defaultToolExposureMode: 'discoverable_only', effectiveToolExposureMode: 'direct' });
  });
  it('lists one named agent and MCP tool from the Action schema and presentation', async () => {
    const fixture = await createFixture();
    try {
      expect(fixture.registry.contributes.actions.find(action => action.pluginId === pluginId
        && action.definition.id === 'review-start')?.definition.title).toBe('Acme Review Start');
      const catalog = projectExecutablePluginToolCatalog(fixture.registry);
      expect(catalog).toEqual([expect.objectContaining({
        toolId: `${pluginId}/review-start`, actionId: `${pluginId}/actions/review-start`,
        name: 'acme_review_start', title: 'Review changes', description: 'Start a review',
        inputSchema, outputSchema: resultSchema, safety: 'safe',
        inputHints: { fields: [{ path: 'scope', title: 'Scope', widget: 'text' }] },
        promptSnippet: 'Start a review when asked.', promptGuidelines: ['Choose the narrowest scope.'],
        surfaces: ['agent', 'mcp', 'cli'],
      })]);
      const cliInventory = createHappierToolInventory({ surface: 'cli', registry: fixture.registry.contributes,
        pluginToolCatalog: catalog, isActionEnabled: () => true, actionsSettings: null });
      expect(cliInventory.tools.filter(tool => tool.name === 'acme_review_start')).toEqual([
        expect.objectContaining({ inputSchema, outputSchema: resultSchema, actionId: `${pluginId}/actions/review-start` }),
      ]);
      for (const surface of ['agent', 'mcp'] as const) {
        const discoverable = resolveDiscoveredPluginActionAvailability({ actionId: `${pluginId}/actions/review-start`, surface,
          surfaces: { agent: true, mcp: true, cli: true, ui: false, voice: false, rpc: false, api: true, plugin: false } });
        expect(discoverable).toMatchObject({ available: true, defaultToolExposureMode: 'discoverable_only' });
        const defaults = createHappierToolInventory({ surface, registry: fixture.registry.contributes,
          pluginToolCatalog: catalog, isActionEnabled: () => true, actionsSettings: null });
        expect(defaults.tools.some(tool => tool.name === 'acme_review_start')).toBe(false);
        const inventory = createHappierToolInventory({ surface, registry: fixture.registry.contributes,
          pluginToolCatalog: catalog, isActionEnabled: () => true, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { [`${pluginId}/actions/review-start`]: { toolExposureModes: { [surface]: 'direct' } } } }) });
        expect(inventory.tools.filter(tool => tool.name === 'acme_review_start')).toEqual([
          expect.objectContaining({ inputSchema, outputSchema: resultSchema, actionId: `${pluginId}/actions/review-start` }),
        ]);
      }
    } finally { await fixture.dispose(); }
  });

  it('uses the Action availability policy for every named-tool surface', async () => {
    const fixture = await createFixture(false);
    try {
      const invocations = fixture.registry.targetActionInvocations;
      if (!invocations) throw new Error('Expected the admitted Action invocation owner');
      expect(invocations.evaluateCatalogPolicy(pluginId, 'review-start').outcome).not.toBe('visible');
      expect(projectExecutablePluginToolCatalog(fixture.registry)).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  it('binds the tool to the same Action contributor occurrence', async () => {
    const fixture = await createFixture();
    try {
      expect(projectOccurrenceBoundExecutablePluginToolCatalog(fixture.registry)).toEqual([
        expect.objectContaining({ toolId: `${pluginId}/review-start`,
          expectedContributorOccurrenceId: fixture.registry.readPluginOccurrenceId?.(pluginId) }),
      ]);
    } finally { await fixture.dispose(); }
  });
});
