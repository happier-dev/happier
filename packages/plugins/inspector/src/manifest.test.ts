import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  INSPECTOR_APP_SURFACE,
  INSPECTOR_NATIVE_BUNDLE_IOS,
  INSPECTOR_NATIVE_BUNDLE_WEB,
  INSPECTOR_NATIVE_BUNDLE_ID,
  INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST,
  INSPECTOR_NATIVE_IOS_CONTAINER_NAME,
  INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST,
  INSPECTOR_PLUGIN_ID,
  INSPECTOR_SETTINGS,
  INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
  PLUGIN_MANIFEST,
} from './manifest';

describe('Plugin Inspector manifest', () => {
  it('authors against the public plugin SDK only', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const manifestSource = readFileSync(new URL('./manifest.ts', import.meta.url), 'utf8');
    const dependencyFields = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      packageJson.optionalDependencies,
    ];
    const forbiddenProtocolPackage = '@happier-dev/' + 'protocol';
    const forbiddenAgentsPackage = '@happier-dev/' + 'agents';

    for (const dependencies of dependencyFields) {
      expect(dependencies ?? {}).not.toHaveProperty(forbiddenProtocolPackage);
      expect(dependencies ?? {}).not.toHaveProperty(forbiddenAgentsPackage);
    }
    expect(manifestSource).not.toContain(forbiddenProtocolPackage);
    expect(manifestSource).not.toContain(forbiddenAgentsPackage);
  });

  it('declares one app-scope reactNative surface, settings, native bundle, and reload hook', () => {
    expect(PLUGIN_MANIFEST.id).toBe(INSPECTOR_PLUGIN_ID);
    expect(PLUGIN_MANIFEST.activationEvents).toEqual(['startup']);
    expect(PLUGIN_MANIFEST.uses).toEqual(['settings', 'reload', 'hooks']);
    expect(PLUGIN_MANIFEST.permissions.required).toEqual([]);
    expect(PLUGIN_MANIFEST.contributes.hooks).toEqual([
      expect.objectContaining({
        id: 'plugin.reload.after',
        handler: { target: 'plugin', exportName: 'handlePluginReloadAfter' },
      }),
    ]);
    expect(PLUGIN_MANIFEST.contributes.surfacePlacements).toEqual([INSPECTOR_APP_SURFACE]);
    expect(PLUGIN_MANIFEST.contributes.reactNativeBundles).toEqual([
      INSPECTOR_NATIVE_BUNDLE_WEB,
      INSPECTOR_NATIVE_BUNDLE_IOS,
    ]);
    // FIX-RNWEB-SERVING: the web sibling is now a REAL, digest-verified
    // production artifact (Vite + react-native-web build of the SAME
    // `renderSurface.tsx` source the ios build compiles) — the SAME
    // `installedArtifact` serving story ios already used, not a
    // dev-hot-reload declaration (a first-party bundled plugin's
    // `pluginSource` correctly classifies as `internal`, which
    // dev-hot-reload correctly denies; see the module doc above).
    expect(INSPECTOR_NATIVE_BUNDLE_WEB).toMatchObject({
      id: INSPECTOR_NATIVE_BUNDLE_ID,
      bundle: {
        platform: 'web',
        channel: 'internal',
        assetPath: 'react-native-web/inspector-app-native/entry.mjs',
        integrity: { digest: INSPECTOR_NATIVE_WEB_ARTIFACT_DIGEST },
      },
      entry: { modulePath: './renderSurface', exportName: 'renderSurface' },
      hostApi: { methods: ['dispatchAction', 'getSurfaceContext'] },
    });
    // NATIVE-PIPELINE: the second sibling contribution — SAME logical id,
    // real ios artifact (built by rspack.config.mjs, digest computed by the
    // real buildUiArtifacts pipeline, not a placeholder).
    expect(INSPECTOR_NATIVE_BUNDLE_IOS).toMatchObject({
      id: INSPECTOR_NATIVE_BUNDLE_ID,
      bundle: {
        platform: 'ios',
        channel: 'internal',
        assetPath: 'react-native/inspector-app-native/ios.bundle.js',
        integrity: { digest: INSPECTOR_NATIVE_IOS_ARTIFACT_DIGEST },
      },
      entry: {
        containerName: INSPECTOR_NATIVE_IOS_CONTAINER_NAME,
        modulePath: './renderSurface',
        exportName: 'renderSurface',
      },
    });
    expect(INSPECTOR_APP_SURFACE).toMatchObject({
      id: 'inspector-app',
      placement: 'app.rightSidebarTab',
      target: { kind: 'app' },
      renderer: { kind: 'reactNative', contributionId: INSPECTOR_NATIVE_BUNDLE_ID },
      rightSidebar: { tabId: 'plugin-inspector', scope: 'app' },
    });
    expect(INSPECTOR_SETTINGS.fields).toEqual([
      expect.objectContaining({
        id: INSPECTOR_SHOW_DIAGNOSTICS_SETTING_ID,
        control: 'switch',
        defaultBooleanValue: true,
      }),
    ]);
  });

  it('retires the hostedWeb contribution — one RN surface is the sole owner (no dual UI)', () => {
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hostedWeb');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('uiArtifacts');
  });
});
