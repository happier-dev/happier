import { definePlugin } from '@happier-dev/plugin-sdk';

import {
  CLIPROXYAPI_PROVIDER_CONTRIBUTION,
  CLIPROXYAPI_PROVIDER_LOCAL_ID,
} from './provider/contribution.js';
import { CLIPROXYAPI_MANAGED_ENV, CLIPROXYAPI_MANAGED_SERVICE } from './provider/managedContract.js';
import { CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME } from './provider/publicManagedRuntime.js';


export const { manifest: PLUGIN_MANIFEST, activate } = definePlugin({
  id: 'happier.provider.cliproxyapi',
  version: '0.0.0',
  displayName: 'CLIProxyAPI',
  description: 'Use models served by an external or locally detected CLIProxyAPI gateway.',
  brand: { iconResourceId: 'brand-icon', monochrome: true },
  resources: {
    'brand-icon': { kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' },
    "i18n-en": { kind: 'asset', path: "assets/i18n/en.json", contentType: 'application/json' },
    "i18n-de": { kind: 'asset', path: "assets/i18n/de.json", contentType: 'application/json' },
    "i18n-ru": { kind: 'asset', path: "assets/i18n/ru.json", contentType: 'application/json' },
    "i18n-pl": { kind: 'asset', path: "assets/i18n/pl.json", contentType: 'application/json' },
    "i18n-es": { kind: 'asset', path: "assets/i18n/es.json", contentType: 'application/json' },
    "i18n-fr": { kind: 'asset', path: "assets/i18n/fr.json", contentType: 'application/json' },
    "i18n-it": { kind: 'asset', path: "assets/i18n/it.json", contentType: 'application/json' },
    "i18n-pt": { kind: 'asset', path: "assets/i18n/pt.json", contentType: 'application/json' },
    "i18n-ca": { kind: 'asset', path: "assets/i18n/ca.json", contentType: 'application/json' },
    "i18n-zh-hans": { kind: 'asset', path: "assets/i18n/zh-Hans.json", contentType: 'application/json' },
    "i18n-zh-hant": { kind: 'asset', path: "assets/i18n/zh-Hant.json", contentType: 'application/json' },
    "i18n-ja": { kind: 'asset', path: "assets/i18n/ja.json", contentType: 'application/json' },
  },
  entrypoints: { daemon: './.happier-plugin/daemon.js' },
  hostAccess: {
    required: [{
      id: 'managed-gateway-environment',
      capability: 'environment',
      reason: 'Configure the managed CLIProxyAPI gateway and its host-owned access bindings.',
      scope: {
        keys: [
          'HOST',
          CLIPROXYAPI_MANAGED_SERVICE.portEnvironmentKey,
          CLIPROXYAPI_MANAGED_ENV.consumerAccessPath,
          CLIPROXYAPI_MANAGED_ENV.downstreamBearer,
          CLIPROXYAPI_MANAGED_ENV.purposeConfiguration,
        ],
      },
    }],
    optional: [],
  },
  ui: { translations: [
    { locale: "en", resourceId: "i18n-en" },
    { locale: "de", resourceId: "i18n-de" },
    { locale: "ru", resourceId: "i18n-ru" },
    { locale: "pl", resourceId: "i18n-pl" },
    { locale: "es", resourceId: "i18n-es" },
    { locale: "fr", resourceId: "i18n-fr" },
    { locale: "it", resourceId: "i18n-it" },
    { locale: "pt", resourceId: "i18n-pt" },
    { locale: "ca", resourceId: "i18n-ca" },
    { locale: "zh-Hans", resourceId: "i18n-zh-hans" },
    { locale: "zh-Hant", resourceId: "i18n-zh-hant" },
    { locale: "ja", resourceId: "i18n-ja" },
  ] },
  providers: {
    [CLIPROXYAPI_PROVIDER_LOCAL_ID]: {
      declaration: CLIPROXYAPI_PROVIDER_CONTRIBUTION,
      runtime: CLIPROXYAPI_PUBLIC_MANAGED_PROVIDER_RUNTIME,
    },
  },
});
