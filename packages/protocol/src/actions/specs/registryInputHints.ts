import type { ActionInputFieldHint } from '../actionInputHintsRuntime.js';
import type { RegistryActionIdV1 } from '../../registries/registryActionsV1.js';

const kind = { path: 'kind', title: 'Item kind', widget: 'text' } as const;
const source = { path: 'sourceId', title: 'Registry', widget: 'text', required: true } as const;
const title = { path: 'title', title: 'Name', widget: 'text' } as const;
const url = { path: 'url', title: 'Address', widget: 'url', required: true } as const;
const enabled = { path: 'enabled', title: 'Enabled', widget: 'boolean' } as const;
const token = { path: 'token', title: 'Saved Secret reference', widget: 'json' } as const;
const npm = { path: 'npmRegistryProfileId', title: 'npm profile', widget: 'text' } as const;

export const REGISTRY_INPUT_FIELDS = {
  'registries.sources.list': [kind],
  'registries.sources.detect': [url],
  'registries.sources.create': [url, title,
    { path: 'kinds', title: 'Contains', widget: 'multiselect', options: [
      { value: 'skill', label: 'Skills' }, { value: 'mcpServer', label: 'MCP servers' },
      { value: 'agent', label: 'Agents' }, { value: 'plugin', label: 'Plugins' }, { value: 'app', label: 'Apps' },
    ] }, token, npm],
  'registries.sources.update': [source, title, enabled],
  'registries.sources.token.set': [source, token, { ...npm, widget: 'json', description: 'An npm profile id string, or null to remove its binding.' }],
  'registries.sources.delete': [source],
  'registries.items.list': [{ ...kind, required: true },
    { path: 'sourceIds', title: 'Registries', widget: 'json' },
    { path: 'contributionFamily', title: 'Plugin contribution family', widget: 'text' },
    { path: 'query', title: 'Search', widget: 'text' },
    { path: 'cursor', title: 'Next page', widget: 'text' },
    { path: 'refresh', title: 'Refresh sources', widget: 'boolean' }],
  'registries.items.read': [{ ...kind, required: true }, source,
    { path: 'itemId', title: 'Item id', widget: 'text', required: true },
    { path: 'version', title: 'Version', widget: 'text' }],
  'registries.updates.check': [kind,
    { path: 'keys', title: 'Installed item keys', widget: 'json' },
    { path: 'environments', title: 'App environments', description: 'Use the exact app environment demands from the installed catalog when kind is app.', widget: 'json' }],
} satisfies Record<RegistryActionIdV1, ActionInputFieldHint[]>;
