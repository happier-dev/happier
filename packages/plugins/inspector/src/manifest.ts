import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginSettingsContribution } from '@happier-dev/plugin-sdk/settings';

export const INSPECTOR_PLUGIN_ID = 'happier.inspector';
export const INSPECTOR_NATIVE_BUNDLE_ID = 'inspector-app-native';
export const INSPECTOR_APP_SURFACE_ID = 'inspector-app';
/**
 * EU-5b dogfood: the inspector's full-page destination. The host routes it at
 * `/plugins/happier.inspector/inspector-page/*` and hands the surface only the
 * remainder as `subPath`; the plugin never names a route.
 */
export const INSPECTOR_PAGE_SURFACE_ID = 'inspector-page';
export const INSPECTOR_RENDERER_ID = 'inspector-renderer';
export const INSPECTOR_SETTINGS_ID = 'settings';
export const INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID = 'show-diagnostics';
export const INSPECTOR_BRAND_RESOURCE_ID = 'brand-icon';
export const INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID = 'inventory-illustration';
/**
 * A small real action owned by the Inspector itself. The surface invokes this
 * through the public Action adapter so the reference plugin exercises the
 * same declared-action/host-dispatch path available to external authors.
 */
export const INSPECTOR_SELF_CHECK_ACTION_ID = 'self-check';

export const INSPECTOR_SETTINGS = {
  id: INSPECTOR_SETTINGS_ID,
  title: { key: 'plugins.inspector.title', fallback: 'Plugin Inspector' },
  description: 'Local presentation preferences for the Plugin Inspector.',
  target: { kind: 'plugin' },
  scope: 'daemon',
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
    container: 'rightSidebarTab' as const,
    target: { kind: 'app' as const },
    renderer: INSPECTOR_RENDERER_ID,
    title: {
      key: 'plugins.inspector.title',
      fallback: 'Plugin Inspector',
    },
  }, {
    // The SAME renderer serves both direct destinations: one surface, two
    // destinations. The host-projected surface context distinguishes them and
    // provides the plugin-local location through `context.subPath` on the page.
    id: INSPECTOR_PAGE_SURFACE_ID,
    container: 'appPage' as const,
    target: { kind: 'app' as const },
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
      // Rendered by the executable surface through `surface.translations`
      // (§3.2): the host projects this bundle for the user's locale, so the
      // surface resolves keys synchronously and never owns a string catalog.
      'plugins.inspector.surface.reload': 'Reload',
      'plugins.inspector.surface.reloading': 'Reloading…',
      'plugins.inspector.surface.search': 'Search installed plugins',
      'plugins.inspector.surface.searchPlaceholder': 'Search by name or plugin ID',
      'plugins.inspector.surface.inventoryIllustration': 'Plugin inventory illustration',
      'plugins.inspector.surface.noMatches': 'No matching plugins',
      'plugins.inspector.surface.noMatchesDescription': 'Try a different name or plugin ID.',
      'plugins.inspector.surface.loading': 'Loading…',
      'plugins.inspector.surface.refreshing': 'Refreshing plugin inventory',
      'plugins.inspector.surface.empty': 'No plugins installed.',
      'plugins.inspector.surface.reloadSucceeded': 'Last reload succeeded',
      'plugins.inspector.surface.reloadFailed': 'Last reload failed',
      'plugins.inspector.surface.openPage': 'Open full page',
      'plugins.inspector.surface.openDiagnostics': 'Open diagnostics',
      'plugins.inspector.surface.pageRoot': 'Page root',
      'plugins.inspector.surface.showActions': 'Inspector actions',
      'plugins.inspector.surface.showActionsContext': 'Open Inspector context actions',
      'plugins.inspector.surface.selfCheck': 'Run Inspector self-check',
      'plugins.inspector.surface.selfCheckDescription': 'Verify the Inspector action bridge.',
    },
  }],
};

export const PLUGIN_MANIFEST = {
  schemaVersion: 2,
  id: INSPECTOR_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Plugin Inspector',
  description: 'First-party Plugin SDK inspector for installed plugin state and reload diagnostics.',
  brand: { iconResourceId: INSPECTOR_BRAND_RESOURCE_ID },
  engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [],
    optional: [],
  },
  contributes: {
    actions: [{
      id: INSPECTOR_SELF_CHECK_ACTION_ID,
      title: {
        key: 'plugins.inspector.surface.selfCheck',
        fallback: 'Run Inspector self-check',
      },
      description: {
        key: 'plugins.inspector.surface.selfCheckDescription',
        fallback: 'Verify the Inspector action bridge.',
      },
      scopes: ['global'],
      surfaces: ['ui'],
      placementBindings: ['toolbar'],
      dangerLevel: 'safe',
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    }],
    resources: [{
      id: INSPECTOR_BRAND_RESOURCE_ID,
      kind: 'asset' as const,
      path: 'assets/brand.png',
      contentType: 'image/png',
    }, {
      id: INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID,
      kind: 'asset' as const,
      path: 'assets/inventory.png',
      contentType: 'image/png',
    }],
    settings: [INSPECTOR_SETTINGS],
    ui: INSPECTOR_UI,
  },
} satisfies PluginManifest;
