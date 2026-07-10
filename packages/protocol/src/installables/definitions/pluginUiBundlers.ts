import type { CapabilityId } from '../../capabilities/index.js';
import { InstallableDependencyDescriptorSchema } from '../descriptor.js';

/**
 * NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 2): managed-installable
 * descriptors for the two plugin-UI build bundlers
 * (`packages/plugin-sdk/src/ui/build/managedBundler.ts`'s
 * `DEFAULT_VITE_INSTALLABLE_ID`/`DEFAULT_REPACK_INSTALLABLE_ID`). Neither
 * descriptor existed anywhere in the repo before this lane (verified by grep
 * — `plugin-ui.bundler.vite`/`plugin-ui.bundler.repack` were referenced only
 * as bare id strings, never registered), so the "vite bundler installable's
 * exact pattern" this lane was pointed at to follow for the repack descriptor
 * did not exist either; both are added together here, in lockstep, for the
 * same `managed_package` shape (npm packages resolved through the managed
 * JS-runtime dependency mechanism, not a system/GitHub-release binary).
 *
 * BUNDLER-DISPATCH follow-up (closes NATIVE-PIPELINE.md's residual):
 * `managedBundler.ts`'s generic dispatch now produces the invocation each
 * real bundler actually accepts — `vite build` (author config auto-discovered
 * at the plugin project root) for vite-bundled surfaces, and
 * `bundle --platform <p> --dev false --minify false --reset-cache` for
 * repack surfaces (Re.Pack has no standalone bin; this descriptor's
 * `binary.commands` is the react-native-community-cli entry point that hosts
 * Re.Pack's `bundle` command). The canonical invocation contract lives in
 * `packages/plugin-sdk/src/ui/build/managedBundler.ts`'s
 * `resolvePluginUiBundlerInvocation`.
 */
export const PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_KEY = 'plugin-ui.bundler.vite' as const;
export const PLUGIN_UI_BUNDLER_VITE_DEP_ID = 'dep.plugin-ui.bundler.vite' as const satisfies CapabilityId;

export const PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_KEY,
  key: PLUGIN_UI_BUNDLER_VITE_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: PLUGIN_UI_BUNDLER_VITE_DEP_ID,
  display: {
    name: 'Vite (plugin UI build)',
    subtitle: 'Bundler for hostedWeb / reactNative-web plugin UI build surfaces',
  },
  description: 'Vite dependency used by the plugin UI build pipeline to compile hostedWeb and reactNative-web build surfaces.',
  source: {
    kind: 'managed_package',
    packageName: 'vite',
    packageManager: 'managed_js_runtime',
  },
  binary: {
    commands: ['vite'],
    systemFirst: false,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: false,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});

export const PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_KEY = 'plugin-ui.bundler.repack' as const;
export const PLUGIN_UI_BUNDLER_REPACK_DEP_ID = 'dep.plugin-ui.bundler.repack' as const satisfies CapabilityId;

export const PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_DESCRIPTOR = InstallableDependencyDescriptorSchema.parse({
  id: PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_KEY,
  key: PLUGIN_UI_BUNDLER_REPACK_INSTALLABLE_KEY,
  kind: 'dep',
  version: '1',
  capabilityId: PLUGIN_UI_BUNDLER_REPACK_DEP_ID,
  display: {
    name: 'Re.Pack (plugin UI build)',
    subtitle: 'Bundler for reactNative (ios/android) plugin UI build surfaces',
  },
  description: '@callstack/repack dependency used by the plugin UI build pipeline to compile reactNative ios/android build surfaces.',
  source: {
    kind: 'managed_package',
    packageName: '@callstack/repack',
    packageManager: 'managed_js_runtime',
  },
  binary: {
    // Re.Pack ships no standalone bin; it is invoked as a
    // react-native-community-cli command (or, as this lane's first real
    // execution did, its exported `bundle` command function directly).
    // `commands` records the conventional react-native-community-cli entry
    // point real callers would install alongside it.
    commands: ['react-native'],
    systemFirst: false,
    managedFallback: true,
  },
  defaultPolicy: {
    autoInstallWhenNeeded: false,
    autoUpdateMode: 'notify',
  },
  consent: {
    install: 'required',
    update: 'required',
  },
  stability: {
    experimental: true,
    supported: true,
  },
});
