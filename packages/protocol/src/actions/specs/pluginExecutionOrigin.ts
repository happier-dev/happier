import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { PLUGIN_EXECUTION_ORIGIN_ACTION_IDS, PluginExecutionOriginActionInputSchemas as inputs,
  PluginExecutionOriginActionOutputSchemas as outputs } from '../pluginExecutionOriginActionFamily.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const titles = {
  'plugins.execution_origin.list': 'List plugin execution origins',
  'plugins.execution_origin.set': 'Choose where a plugin runs',
  'plugins.execution_origin.clear': 'Clear plugin execution origin preference',
};
function createPluginExecutionOriginActionSpecs() {
  return PLUGIN_EXECUTION_ORIGIN_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, approval: { result: 'required' }, title: titles[id], description: 'Read or change where a plugin runs on the answering device and Home, or an addressed mounted contextual choice. clientId selects an exact connected app; unselected mutations refuse when several apps can answer. List returns answeringClientId for subsequent calls. An unavailable explicit Machine blocks its operations; source custody is resolved for each operation.',
  safety: 'safe', sideEffectClass: id.endsWith('.list') ? 'read' : 'write',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  cli: { acceptsServerId: true, commands: [{ path: id.split('.').map(segment => segment.replaceAll('_', '-')), visibility: 'canonical' }] },
  bindings: { mcpToolName: id.replaceAll('.', '_') }, inputSchema: inputs[id], outputSchema: outputs[id],
  inputHints: { fields: [
    { path: 'pluginId', title: 'Plugin', widget: 'text', required: true },
    { path: 'clientId', title: 'Exact answering client', widget: 'text', required: false },
    { path: 'contextualTarget', title: 'Mounted contextual target', widget: 'json', required: false },
    ...(id === 'plugins.execution_origin.list' ? [{ path: 'contextual', title: 'Discover mounted contextual targets', widget: 'boolean' as const, required: false }] : []),
    ...(id === 'plugins.execution_origin.set' ? [{ path: 'origin', title: 'Exact execution origin', widget: 'json' as const, required: true }] : []),
  ] },
}));
}

export const PLUGIN_EXECUTION_ORIGIN_ACTION_SPECS: ReturnType<typeof createPluginExecutionOriginActionSpecs> = lazyActionSpecArray(createPluginExecutionOriginActionSpecs);
