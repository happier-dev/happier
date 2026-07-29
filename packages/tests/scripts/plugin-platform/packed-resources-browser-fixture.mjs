export function buildPackedResourcesBrowserManifest({
  manifest,
  pluginId,
  version,
}) {
  const developmentEntrypoint = manifest?.entrypoints?.development;
  if (typeof developmentEntrypoint !== 'string' || developmentEntrypoint.length === 0) {
    throw new Error('packed_resources_browser_development_entrypoint_missing');
  }
  if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
    throw new Error('packed_resources_browser_plugin_id_missing');
  }
  return {
    ...manifest,
    version,
    entrypoints: {
      daemon: './dist/index.js',
      development: developmentEntrypoint,
    },
    activation: { events: [{ kind: 'startup' }] },
    contributes: {
      actions: [{
        id: 'roundtrip',
        title: 'Read packed resources',
        scopes: ['global'],
        surfaces: ['ui'],
        placement: 'commandPalette',
        dangerLevel: 'safe',
      }],
      resources: [{
        id: 'prompt',
        kind: 'prompt',
        path: 'resources/prompt.md',
        contentType: 'text/markdown',
      }, {
        id: 'skill',
        kind: 'skill',
        path: 'resources/skill.md',
        contentType: 'text/markdown',
      }, {
        id: 'template',
        kind: 'template',
        path: 'resources/template.txt',
        contentType: 'text/plain',
      }, {
        id: 'asset',
        kind: 'asset',
        path: 'resources/asset.json',
        contentType: 'application/json',
      }, {
        id: 'config',
        kind: 'config',
        path: 'resources/config.json',
        contentType: 'application/json',
      }],
      browserTargets: [{
        id: 'preview',
        title: 'Packed resources preview',
        url: 'https://preview.example.test/',
        launch: 'currentView',
        profile: 'user',
      }],
      browserActions: [{
        id: 'preview-toolbar',
        title: 'Read packed resources',
        action: 'roundtrip',
        target: 'preview',
        placement: 'toolbar',
        icon: 'play-outline',
      }, {
        id: 'preview-details',
        title: 'Inspect packed resources',
        action: 'roundtrip',
        target: 'preview',
        placement: 'detailsPanel',
        icon: 'search-outline',
      }, {
        id: 'preview-context',
        title: 'Use packed resources',
        action: 'roundtrip',
        target: 'preview',
        placement: 'contextMenu',
        icon: 'copy-outline',
      }],
    },
  };
}

export function packedResourcesBrowserPayloads(version) {
  return {
    prompt: `# Packed prompt ${version}\n`,
    skill: `# Packed skill ${version}\n`,
    template: `Packed template ${version}\n`,
    asset: `${JSON.stringify({ kind: 'asset', version })}\n`,
    config: `${JSON.stringify({ kind: 'config', version })}\n`,
  };
}

export function buildPackedResourcesBrowserRuntimeSource({
  pluginId,
  version,
}) {
  return [
    "import { appendFileSync } from 'node:fs';",
    "import type { PluginApi } from '@happier-dev/plugin-sdk';",
    "import type { ActionHandler } from '@happier-dev/plugin-sdk/runtime';",
    '',
    `const pluginId = ${JSON.stringify(pluginId)};`,
    `const pluginVersion = ${JSON.stringify(version)};`,
    "const markerPath = process.env.HAPPIER_PACKED_RESOURCES_BROWSER_MARKER;",
    '',
    'const roundtrip: ActionHandler = async (input, context) => {',
    '  const decoder = new TextDecoder();',
    '  const resources = {',
    "    prompt: decoder.decode((await context.services.resources.read('prompt')).bytes),",
    "    skill: decoder.decode((await context.services.resources.read('skill')).bytes),",
    "    template: decoder.decode((await context.services.resources.read('template')).bytes),",
    "    asset: decoder.decode((await context.services.resources.read('asset')).bytes),",
    "    config: decoder.decode((await context.services.resources.read('config')).bytes),",
    '  };',
    '  const result = { pluginId, version: pluginVersion, resources, input };',
    '  if (markerPath) {',
    "    appendFileSync(markerPath, `${JSON.stringify(result)}\\n`, 'utf8');",
    '  }',
    '  return result;',
    '};',
    '',
    'export function activate(api: PluginApi): void {',
    "  api.actions.register('roundtrip', roundtrip);",
    '}',
    '',
  ].join('\n');
}
