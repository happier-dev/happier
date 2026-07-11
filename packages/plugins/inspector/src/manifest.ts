import {
  definePluginManifest,
  definePluginSettingsContribution,
  defineSurfaceContribution,
  defineUiTranslations,
  type PluginManifestV2,
  type PluginHookContributionV2,
  type PluginReactNativeBundleContributionV1,
  type PluginSettingsContributionV2,
  type PluginSurfacePlacementDescriptorV1,
  type PluginUiTranslationsContributionV1,
} from '@happier-dev/plugin-sdk';

export const INSPECTOR_PLUGIN_ID = 'happier.inspector';
export const INSPECTOR_PLUGIN_PACKAGE_NAME = '@happier-dev/plugins-inspector';
export const INSPECTOR_NATIVE_BUNDLE_ID = 'inspector-app-native';
export const INSPECTOR_APP_SURFACE_ID = 'inspector-app';
export const INSPECTOR_SETTINGS_ID = 'happier.inspector.settings';
export const INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID = 'happier.inspector.showDiagnostics';
// NATIVE-PIPELINE: the Module Federation container name the native (ios)
// bundle exposes `./renderSurface` from — MUST match exactly what the host
// loader computes at runtime (apps/ui/sources/components/plugins/reactNative
// /loader.ts's `sanitizeFederatedIdentifier('<pluginId>_<contributionId>')`,
// i.e. `happier.inspector_inspector-app-native` with every non
// `[A-Za-z0-9_$]` character replaced by `_`). `rspack.config.mjs` derives its
// own `CONTAINER_NAME` constant the same way — kept as a literal in both
// places (not imported) since one is TS package source, the other a
// standalone build-tool config with no compile step of its own.
export const INSPECTOR_NATIVE_IOS_CONTAINER_NAME = 'happier_inspector_inspector_app_native';
// RN-HARDEN item 1: the ios artifact was REBUILT for real (Re.Pack/rspack,
// same `rspack.config.mjs`) after wiring
// `createStrictSafeGuardedRequireRspackPlugin()` — Re.Pack's injected
// `guardedRequire` runtime module is fatal under the strict-mode IIFE rspack
// emits (`TypeError: Cannot assign to read-only property 'length'`, an
// upstream `@callstack/repack` bug; see
// `@happier-dev/plugin-sdk/experimental/ui/reactNativeRepackStrictSafety`'s
// module doc). The rebuilt bundle is 33638 bytes (was 33512 — the try/catch
// wrapper's own bytes); digest recomputed for real via `shasum -a 256` +
// Node's `crypto` on the actual rebuilt file (both agree), and verified the
// emitted asset now contains the strict-safe `try { ... } catch` form (grep,
// exactly once) instead of the unguarded assignment.
export const INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST =
  'sha256:db45b47a69460bd1b062b0569438b1bfef2f2a959c5745efeacc25599cf3393d';
// FIX-RNWEB-SERVING: relative to `dist/happier-plugin-ui/` (matches
// `buildUiArtifacts()`'s own `output.entry` convention and the real
// `dist/happier-plugin-ui/ui-artifacts.json` this repo's build produced) —
// NOT relative to the plugin package root. See
// `apps/cli/.../firstPartyUiContributions.ts`'s `INSPECTOR_UI_ARTIFACTS_ROOT_PATH`
// for the matching `pluginRootPath` fix (a real, previously-uncaught
// byte-serving resolution bug found while wiring the web sibling: the ios
// artifact registered by NATIVE-PIPELINE could never actually be read from
// disk by the daemon's `DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ` handler with
// this asset path against the package-root `pluginRootPath` it shipped
// with — untested until this lane needed the same byte-serving path for web).
export const INSPECTOR_NATIVE_IOS_ASSET_PATH = 'react-native/inspector-app-native/ios.bundle.js';
export const INSPECTOR_NATIVE_IOS_SOURCE_MAP_PATH = 'react-native/inspector-app-native/ios.bundle.js.map';
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_PATH =
  'react-native/inspector-app-native/src_ui_renderSurface_tsx.chunk.bundle';
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_PATH =
  'react-native/inspector-app-native/src_ui_renderSurface_tsx.chunk.bundle.map';
export const INSPECTOR_NATIVE_IOS_SOURCE_MAP_DIGEST =
  'sha256:a988ddc024991eca0f49904dd23021e9f397d8d0d4a16834697745751ed9aa27';
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_DIGEST =
  'sha256:89d594648eec04ae456444a8ab5f7ff813a25df2d5319633bfed190696605613';
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_DIGEST =
  'sha256:b39f1c70b4c76210a7f9165a7981348b4c96f1152e6eddbbbd2bd3065f5a0d2a';
export const INSPECTOR_NATIVE_IOS_SOURCE_MAP_BYTE_SIZE = 36262;
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_BYTE_SIZE = 19897;
export const INSPECTOR_NATIVE_IOS_RENDER_SURFACE_CHUNK_SOURCE_MAP_BYTE_SIZE = 25937;
// FIX-RNWEB-SERVING: the inspector's real, digest-verified web artifact
// (`packages/plugin-sdk/experimental/ui/reactNativeWebBuild`'s Vite +
// react-native-web build of the SAME `src/ui/renderSurface.tsx` source the
// ios build compiles — "ship one sourceEntry, get all platforms", LEDGER
// DEC-6). Digest computed for real over the actual built
// `dist/happier-plugin-ui/react-native-web/inspector-app-native/entry.mjs`
// (10463 bytes), not a placeholder — see `FIX-RNWEB-SERVING.md` for the
// build command and defects fixed to make this build succeed for the first
// time (`hostRuntimeExternalsBuildPlugin.ts`'s real-module resolution +
// `react-native-web` missing as a real dependency of this package).
export const INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST =
  'sha256:e20e9a048bc36e6951e73369c71fb343aea6d3c9ad9fcdae755dcd4195dc6467';
export const INSPECTOR_NATIVE_WEB_ASSET_PATH = 'react-native-web/inspector-app-native/entry.mjs';
export const INSPECTOR_NATIVE_WEB_ARTIFACT_BYTE_SIZE = 10463;

export const INSPECTOR_UI_TRANSLATIONS: PluginUiTranslationsContributionV1 = defineUiTranslations({
  defaultLocale: 'en',
  locales: {
    en: {
      'plugins.inspector.title': 'Plugin Inspector',
      'plugins.inspector.description': 'Inspect installed plugins, diagnostics, and reload state.',
      'plugins.inspector.settings.showDiagnostics': 'Show diagnostics in Plugin Inspector',
      'plugins.inspector.settings.showDiagnostics.description': 'Display per-plugin diagnostic details in the inspector surface.',
    },
  },
});

// RN-DOGFOOD (LEDGER DEC-6/DEC-7): the inspector's UI is now the ONE
// RN-authored surface at `src/ui/renderSurface.tsx`, built for web via
// `vite.config.ts` (`defineReactNativeWebViteBuildPreset`) and, once a
// native Re.Pack build pipeline exists in this repo, for native via
// `defineReactNativeRepackBuildPreset` against the SAME source — see
// `vite.config.ts`'s module doc for the current build-target status.
//
// The previous `hostedWeb` contribution (`INSPECTOR_APP_HOSTED_WEB`) is
// RETIRED, not kept alongside: it shipped a manifest reference to a static
// HTML artifact with no real source ever checked into this repo (`sha256:
// c78c72...`, `static-assets/` was `.gitignore`'d and empty) — an inert
// stub, never a working second UI. One RN surface is the one owner; keeping
// a dead hostedWeb contribution "just in case" would be exactly the
// dual-UI/split-brain authoring confusion LEDGER DEC-6 named.
//
// NATIVE-PIPELINE (LEDGER DEC-6 follow-up): the ios entry below is the
// SECOND sibling `reactNativeBundles` contribution sharing this SAME logical
// `id` — the registry/projection-level "one platform per contribution id"
// gap RN-DOGFOOD found (`createResolvedContributionRegistry.ts`'s per-id
// uniqueness map, `projection.ts`'s strict single-entry resolution) is fixed:
// the registry now dedupes `reactNativeBundles` by `id:platform`, and
// `projection.ts#projectReactNativeBundles` selects the sibling matching the
// connecting client's own reported runtime platform at projection time (one
// resolution point, not per-caller branching). `INSPECTOR_APP_SURFACE`'s
// `renderer.contributionId` below references the shared, platform-agnostic
// `id` — unchanged by this widening.
//
// FIX-RNWEB-SERVING (LIVE-MATRIX Cell-1 structural finding): this sibling
// used to be a `channel:'development'` dev-hot-reload-only declaration with
// no built artifact — for a FIRST-PARTY BUNDLED plugin (`provenance:
// 'first_party'`), `ui/projection.ts#resolveReactNativePluginSource`
// correctly classifies that as `pluginSource:'internal'`, which
// `reactNativeRuntime.ts#resolveDevHotReloadProjection` correctly denies
// (dev-hot-reload is a `local_trusted` DEV-plugin affordance, not a
// production one) — so the web sibling could never become loadable as
// wired, independent of any feature gate. The root-cause fix is NOT to bend
// that dev-hot-reload gate; it is to give this first-party plugin a REAL,
// digest-verified, production artifact on web — the SAME
// `installedArtifact` serving story NATIVE-PIPELINE already wired for ios
// (`resolveReactNativeBundleRuntimeProjection` only takes the
// dev-hot-reload branch when the resolved artifact carries a `devUrl`; a
// built artifact with `assetPath`+`integrity` and no `devUrl` flows straight
// into the SAME `validateInstalledReactNativeBundleArtifact` path ios uses —
// no `pluginSource` check applies there at all). See
// `FIRST_PARTY_UI_ARTIFACTS` in `firstPartyUiContributions.ts` for the
// matching `uiArtifact` registration this bundle now resolves against.
export const INSPECTOR_NATIVE_BUNDLE_WEB: PluginReactNativeBundleContributionV1 = defineSurfaceContribution({
  mode: 'reactNative',
  contribution: {
    id: INSPECTOR_NATIVE_BUNDLE_ID,
    bundle: {
      platform: 'web',
      channel: 'internal',
      assetPath: INSPECTOR_NATIVE_WEB_ASSET_PATH,
      integrity: { digest: INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST },
    },
    entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
    compatibility: {
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      supportedPlatforms: ['web'],
      supportedChannels: ['internal', 'development'],
      requiredNativeCapabilities: [],
    },
    hostApi: {
      minVersion: '1.0.0',
      methods: ['dispatchAction', 'getSurfaceContext'],
    },
    nativeCapabilities: [],
    fallback: { kind: 'unavailable' },
    display: {
      titleKey: 'plugins.inspector.title',
      descriptionKey: 'plugins.inspector.description',
      developerFallback: 'Plugin Inspector',
      iconToken: 'info',
      tone: 'info',
    },
  },
});

// NATIVE-PIPELINE: the FIRST real Re.Pack-built artifact in this repo — a
// real Module Federation container compiled from the SAME
// `src/ui/renderSurface.tsx` source the web build compiles, via
// `rspack.config.mjs` + `happier-plugin-ui.config.mjs` (`buildUiArtifacts`
// digest below is the real sha256 over the built `ios.bundle.js` + its chunk
// + both sourcemaps, not a placeholder). `entry.containerName` matches
// `INSPECTOR_NATIVE_IOS_CONTAINER_NAME` exactly — the host loader's own
// `sanitizeFederatedIdentifier('happier.inspector_inspector-app-native')`.
export const INSPECTOR_NATIVE_BUNDLE_IOS: PluginReactNativeBundleContributionV1 = defineSurfaceContribution({
  mode: 'reactNative',
  contribution: {
    id: INSPECTOR_NATIVE_BUNDLE_ID,
    bundle: {
      platform: 'ios',
      channel: 'internal',
      assetPath: INSPECTOR_NATIVE_IOS_ASSET_PATH,
      integrity: { digest: INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST },
    },
    entry: {
      containerName: INSPECTOR_NATIVE_IOS_CONTAINER_NAME,
      modulePath: './renderSurface',
      exportName: 'renderSurface',
    },
    compatibility: {
      hostUiApiVersion: '1.0.0',
      reactVersion: '19.2.0',
      reactNativeVersion: '0.83.4',
      supportedPlatforms: ['ios'],
      supportedChannels: ['internal', 'development'],
      requiredNativeCapabilities: [],
    },
    hostApi: {
      minVersion: '1.0.0',
      methods: ['dispatchAction', 'getSurfaceContext'],
    },
    nativeCapabilities: [],
    fallback: { kind: 'unavailable' },
    display: {
      titleKey: 'plugins.inspector.title',
      descriptionKey: 'plugins.inspector.description',
      developerFallback: 'Plugin Inspector',
      iconToken: 'info',
      tone: 'info',
    },
  },
});

export const INSPECTOR_APP_SURFACE: PluginSurfacePlacementDescriptorV1 = defineSurfaceContribution({
  mode: 'surfacePlacement',
  contribution: {
    id: INSPECTOR_APP_SURFACE_ID,
    placement: 'app.rightSidebarTab',
    target: { kind: 'app' },
    renderer: {
      kind: 'reactNative',
      contributionId: INSPECTOR_NATIVE_BUNDLE_ID,
    },
    actions: [],
    hostActions: [],
    display: {
      titleKey: 'plugins.inspector.title',
      descriptionKey: 'plugins.inspector.description',
      developerFallback: 'Plugin Inspector',
      iconToken: 'info',
      tone: 'info',
    },
    order: 20,
    rightSidebar: {
      tabId: 'plugin-inspector',
      scope: 'app',
      section: 'plugin',
      order: 20,
      disabledPolicy: 'hide',
      collisionPolicy: 'reject',
      lifecycle: {
        retention: 'retainWhileAvailable',
        unmountOnGenerationChange: true,
      },
    },
  },
});

export const INSPECTOR_SETTINGS: PluginSettingsContributionV2 = definePluginSettingsContribution({
  id: INSPECTOR_SETTINGS_ID,
  fields: [
    {
      id: INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
      kind: 'settings.field',
      version: '1',
      valueSchema: { type: 'boolean' },
      control: 'switch',
      displayKey: 'plugins.inspector.settings.showDiagnostics',
      descriptionKey: 'plugins.inspector.settings.showDiagnostics.description',
      capabilityGates: [],
      permissionGates: [],
      defaultBooleanValue: true,
      clearWhenEmpty: 'persist',
      redaction: 'none',
      hidden: false,
      order: 10,
    },
  ],
});

type InspectorPluginManifestV2 = Omit<PluginManifestV2, 'contributes'> & Readonly<{
  contributes: Readonly<{
    hooks: readonly PluginHookContributionV2[];
    uiTranslations: readonly PluginUiTranslationsContributionV1[];
    surfacePlacements: readonly PluginSurfacePlacementDescriptorV1[];
    reactNativeBundles: readonly PluginReactNativeBundleContributionV1[];
    settings: readonly PluginSettingsContributionV2[];
  }>;
}>;

export const PLUGIN_MANIFEST: InspectorPluginManifestV2 = definePluginManifest({
  schemaVersion: 2,
  id: INSPECTOR_PLUGIN_ID,
  version: '0.0.0',
  displayName: 'Plugin Inspector',
  description: 'First-party Plugin SDK inspector for installed plugin state and reload diagnostics.',
  engines: { happier: '^0.0.0' },
  uses: ['settings', 'reload', 'hooks'],
  activationEvents: ['startup'],
  entrypoints: { main: './dist/index.js' },
  permissions: {
    required: [],
    optional: [],
  },
  contributes: {
    hooks: [
      {
        id: 'plugin.reload.after',
        hookApiVersion: 1,
        category: 'lifecycle',
        scope: 'plugin',
        executionKind: 'observe',
        handler: {
          target: 'plugin',
          exportName: 'handlePluginReloadAfter',
        },
      },
    ],
    uiTranslations: [INSPECTOR_UI_TRANSLATIONS],
    surfacePlacements: [INSPECTOR_APP_SURFACE],
    reactNativeBundles: [INSPECTOR_NATIVE_BUNDLE_WEB, INSPECTOR_NATIVE_BUNDLE_IOS],
    settings: [INSPECTOR_SETTINGS],
  },
} satisfies InspectorPluginManifestV2);
