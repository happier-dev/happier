import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import type { PluginDevLoopActionIdV1 } from '../actionIds.js';

const machine = { path: 'machineId', title: 'Machine', widget: 'text' } as const;
const plugin = { path: 'pluginId', title: 'Plugin id', widget: 'text', required: true } as const;
const root = { path: 'projectRoot', title: 'Plugin project folder', widget: 'text', required: true } as const;
const registry = { path: 'sdkRegistryOrigin', title: 'SDK registry', widget: 'url' } as const;
const locator = { path: 'locator', title: 'Plugin folder or package', widget: 'text', required: true } as const;
const dispositions = { path: 'managedResourceDispositions', title: 'Managed resource choices', widget: 'json' } as const;
const scope = { path: 'scope', title: 'Scope', widget: 'select', options: [
  { value: 'machine', label: 'This Machine' }, { value: 'account', label: 'Account' },
] } as const;
const development = [root, registry];

export const PLUGIN_DEVELOPMENT_INPUT_FIELDS = {
  'plugins.scaffold': [
    { path: 'targetDir', title: 'New plugin folder', widget: 'text', required: true },
    { path: 'id', title: 'Plugin id', widget: 'text', required: true },
    { path: 'name', title: 'Plugin name', widget: 'text', required: true }, machine,
    { path: 'ui', title: 'UI mode', widget: 'text' },
    { path: 'template', title: 'Starting template', widget: 'text' },
  ],
  'plugins.install': [
    { path: 'source', title: 'Source', widget: 'json' },
    { path: 'path', title: 'Local path or package', widget: 'text' }, machine,
    { path: 'kind', title: 'Install from', widget: 'select', options: [
      { value: 'path', label: 'Local folder' }, { value: 'archive', label: 'Archive' }, { value: 'npm', label: 'npm package' },
    ] },
    { path: 'selector', title: 'Package selection', widget: 'text' },
    { path: 'integrity', title: 'Integrity', widget: 'text' }, registry,
    { path: 'dev', title: 'Development install', widget: 'boolean' },
    { path: 'dryRun', title: 'Preview only', widget: 'boolean' },
    { path: 'force', title: 'Replace existing install', widget: 'boolean' },
  ],
  'plugins.uninstall': [plugin, machine, dispositions, { path: 'deleteData', title: 'Delete plugin data', widget: 'boolean' }],
  'plugins.enable': [plugin, machine, scope],
  'plugins.disable': [plugin, machine, scope, dispositions],
  'plugins.rollback': [plugin, machine],
  'plugins.trust.forget': [plugin, machine],
  'plugins.update_policy.set': [plugin, machine, { path: 'policy', title: 'Update policy', widget: 'json', required: true }],
  'plugins.dev.submit': development,
  'plugins.dev.unregister': [root],
  'plugins.dev.install': development,
  'plugins.dev.typecheck': development,
  'plugins.dev.build': development,
  'plugins.dev.test': development,
  'plugins.doctor': [locator],
  'plugins.pack': [locator, { path: 'outPath', title: 'Archive output path', widget: 'text' }, registry],
  'plugins.reload': [plugin],
  'plugins.list': [],
  'plugins.change.status': [{ path: 'pendingChangeId', title: 'Pending change id', widget: 'text', required: true }],
} satisfies Record<PluginDevLoopActionIdV1, ActionInputFieldHint[]>;
