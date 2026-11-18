import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
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
export const INSPECTOR_BROWSER_PANEL_SURFACE_ID = 'inspector-browser-panel';
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

/**
 * A deliberately side-effect-free action used by the reference surface to
 * prove the public declared-action path without creating another dispatcher.
 */
export const runInspectorSelfCheck: ActionHandler = async () => ({ ok: true });

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
    placement: { kind: 'rail' as const },
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
    description: {
      key: 'plugins.inspector.description',
      fallback: 'Inspect installed plugins, diagnostics, and reload state.',
    },
    placement: { kind: 'rail' as const },
  }, {
    id: INSPECTOR_BROWSER_PANEL_SURFACE_ID,
    container: 'browserPanel' as const,
    target: { kind: 'browser' as const, browserViewIdPath: '/browser/viewId' },
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
  translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ],
};

export const INSPECTOR_PLUGIN = definePlugin({
  id: INSPECTOR_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Plugin Inspector',
  description: 'First-party Plugin SDK inspector for installed plugin state and reload diagnostics.',
  brand: { iconResourceId: INSPECTOR_BRAND_RESOURCE_ID },
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  hostAccess: {
    required: [],
    optional: [],
  },
  actions: {
    [INSPECTOR_SELF_CHECK_ACTION_ID]: {
      title: {
        key: 'plugins.inspector.surface.selfCheck',
        fallback: 'Run Inspector self-check',
      },
      description: {
        key: 'plugins.inspector.surface.selfCheckDescription',
        fallback: 'Verify the Inspector action bridge.',
      },
      surfaces: ['ui', 'agent', 'mcp', 'cli', 'plugin'],
      placementBindings: ['toolbar'],
      resultSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      run: runInspectorSelfCheck,
    },
  },
  resources: {
    [INSPECTOR_BRAND_RESOURCE_ID]: {
      kind: 'asset' as const,
      path: 'assets/brand.png',
      contentType: 'image/png',
    },
    [INSPECTOR_INVENTORY_ILLUSTRATION_RESOURCE_ID]: {
      kind: 'asset' as const,
      path: 'assets/inventory.png',
      contentType: 'image/png',
    },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  settings: {
    [INSPECTOR_SETTINGS_ID]: INSPECTOR_SETTINGS,
  },
  ui: INSPECTOR_UI,
});

export const PLUGIN_MANIFEST = INSPECTOR_PLUGIN.manifest;
