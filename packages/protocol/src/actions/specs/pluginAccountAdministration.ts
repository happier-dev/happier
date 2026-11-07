import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS,
  PluginAccountAdministrationActionInputSchemas as inputs,
  PluginAccountAdministrationActionOutputSchemas as outputs } from '../pluginAccountAdministrationActionFamily.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const titles = {
  'plugins.account.release.select': 'Select a plugin release for your Account',
  'plugins.account.hosting.set': 'Set plugin Account hosting',
  'plugins.account.hosting.remove': 'Disable and remove hosted plugin artifacts',
  'plugins.account.cache.clear': 'Clear downloaded plugin artifacts on this device',
};
function createPluginAccountAdministrationActionSpecs() {
  return PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, title: titles[id], approval: { result: 'required' },
  ...(id === 'plugins.account.hosting.remove' ? { irreversible: true as const } : {}),
  description: 'Use the answering app’s Account Availability selector, intent CAS, exact hosted artifact removal and device download cache owners.',
  safety: id === 'plugins.account.hosting.remove' ? 'danger' : 'safe',
  sideEffectClass: id === 'plugins.account.hosting.remove' ? 'danger' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false },
  cli: { acceptsServerId: true, commands: [] },
  bindings: { mcpToolName: id.replaceAll('.', '_') },
  inputSchema: inputs[id], outputSchema: outputs[id],
  inputHints: { fields: [
    { path: 'pluginId', title: 'Plugin', widget: 'text', required: true },
    ...(id === 'plugins.account.release.select' ? [
      { path: 'version', title: 'Exact release version', widget: 'text' as const, required: true },
      { path: 'daemon', title: 'Exact candidate daemon source', widget: 'json' as const, required: false },
    ] : []),
    ...(id === 'plugins.account.hosting.set' ? [{ path: 'enabled', title: 'Enable Account hosting', widget: 'boolean' as const, required: true }] : []),
  ] },
}));
}

export const PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_SPECS: ReturnType<typeof createPluginAccountAdministrationActionSpecs> = lazyActionSpecArray(createPluginAccountAdministrationActionSpecs);
