import type {
  PluginManifest,
  PluginSettingsContribution,
} from '@happier-dev/plugin-sdk/manifest';

export const INSPECTOR_PLUGIN_ID = 'happier.inspector';
export const INSPECTOR_NATIVE_BUNDLE_ID = 'inspector-app-native';
export const INSPECTOR_APP_SURFACE_ID = 'inspector-app';
export const INSPECTOR_RENDERER_ID = 'inspector-renderer';
export const INSPECTOR_SETTINGS_ID = 'settings';
export const INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID = 'show-diagnostics';

export const INSPECTOR_SETTINGS = {
  id: INSPECTOR_SETTINGS_ID,
  title: { key: 'plugins.inspector.title', fallback: 'Plugin Inspector' },
  description: 'Local presentation preferences for the Plugin Inspector.',
  target: { kind: 'plugin' },
  scope: 'local',
  fields: [
    {
      id: INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
      title: {
        key: 'plugins.inspector.settings.showDiagnostics',
        fallback: 'Show diagnostics in Plugin Inspector',
      },
      description: {
        key: 'plugins.inspector.settings.showDiagnostics.description',
        fallback: 'Display per-plugin diagnostic details in the inspector surface.',
      },
      schema: { type: 'boolean' },
      default: true,
    },
  ],
} satisfies PluginSettingsContribution;

export const INSPECTOR_UI = {
  views: [{
    id: INSPECTOR_APP_SURFACE_ID,
    placement: 'app.rightSidebarTab' as const,
    renderer: INSPECTOR_RENDERER_ID,
    title: {
      key: 'plugins.inspector.title',
      fallback: 'Plugin Inspector',
    },
  }],
  renderers: [{
    id: INSPECTOR_RENDERER_ID,
    kind: 'reactNative' as const,
    artifact: INSPECTOR_NATIVE_BUNDLE_ID,
    requiredHostMethods: ['executeAction' as const],
  }],
  translations: [{
    locale: 'en',
    messages: {
      'plugins.inspector.title': 'Plugin Inspector',
      'plugins.inspector.description': 'Inspect installed plugins, diagnostics, and reload state.',
      'plugins.inspector.settings.showDiagnostics': 'Show diagnostics in Plugin Inspector',
      'plugins.inspector.settings.showDiagnostics.description': 'Display per-plugin diagnostic details in the inspector surface.',
    },
  }],
};

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: INSPECTOR_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Plugin Inspector',
  description: 'First-party Plugin SDK inspector for installed plugin state and reload diagnostics.',
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [],
    optional: [],
  },
  contributes: {
    settings: [INSPECTOR_SETTINGS],
    ui: INSPECTOR_UI,
  },
} satisfies PluginManifest;
