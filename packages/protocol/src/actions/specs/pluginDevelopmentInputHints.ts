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
const publicationSource = [{ ...root, required: false },
  { path: 'botTemplate', title: 'Reviewed Bot template draft and release projection', widget: 'json' }] as const;

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
  'plugins.dev.publication.inspect': [...publicationSource, machine, { path: 'profileId', title: 'npm profile', widget: 'text' }, { path: 'packageName', title: 'Package', widget: 'text' }, { path: 'cursor', title: 'Version page', widget: 'text' },
    { path: 'includeGithub', title: 'Inspect GitHub publication choices', widget: 'boolean' }],
  'plugins.dev.publication.prepare': [...publicationSource, machine, { path: 'profileId', title: 'npm profile', widget: 'text' }, { path: 'publication', title: 'Reviewed publication metadata', widget: 'json' }],
  'plugins.dev.publish': [...publicationSource, machine, { path: 'profileId', title: 'npm profile', widget: 'text' }, { path: 'publication', title: 'Reviewed publication metadata', widget: 'json' },
    { path: 'access', title: 'Access', widget: 'text', required: true }, { path: 'mode', title: 'Publication mode', widget: 'text', required: true },
    { path: 'expectedArchiveIntegrity', title: 'Reviewed archive integrity', widget: 'text' }, { path: 'github', title: 'Selected GitHub effects', widget: 'json' },
    { path: 'githubOnly', title: 'Retry GitHub only', widget: 'boolean' }],
  'plugins.dev.publication.status': [machine, { path: 'profileId', title: 'npm profile', widget: 'text', required: true },
    { path: 'packageName', title: 'Package', widget: 'text', required: true }, { path: 'version', title: 'Version', widget: 'text', required: true },
    { path: 'integrity', title: 'Archive integrity', widget: 'text', required: true }],
  'plugins.doctor': [locator],
  'plugins.pack': [locator, { path: 'outPath', title: 'Archive output path', widget: 'text' }, registry],
  'plugins.reload': [plugin],
  'plugins.list': [],
  'plugins.change.status': [{ path: 'pendingChangeId', title: 'Pending change id', widget: 'text', required: true }],
} satisfies Record<PluginDevLoopActionIdV1, ActionInputFieldHint[]>;
