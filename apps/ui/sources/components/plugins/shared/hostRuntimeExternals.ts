import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as PluginUiHostApiClient from '@happier-dev/plugin-sdk/ui/client';
// Metro aliases `react-native` -> `react-native-web` for apps/ui's own code on
// the web platform target (apps/ui/metro.config.js) — reusing that SAME
// aliasing here (rather than adding a direct `react-native-web` dependency)
// keeps this file's react-native-web instance identical to the one the rest
// of the app already renders with.
import * as ReactNativeWebNamespace from 'react-native';

import {
    PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY,
    type PluginUiHostRuntimeExternalGlobalV1,
} from '@happier-dev/protocol/plugins/ui';

/**
 * RN-WEB-LOADER item 1 (shared externals-resolution fix) — host-runtime half.
 *
 * `packages/plugin-sdk/src/ui/hostRuntimeExternalsBuildPlugin.ts` aliases a
 * web-target plugin bundle's exact React runtime namespaces /
 * `react-native-web` /
 * `@happier-dev/plugin-sdk/ui/client` imports to a virtual module that
 * reads `globalThis[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY]`. This module installs
 * the REAL host-side module namespaces there — once, idempotently — before
 * any web-target plugin bundle is `import()`-ed, so a plugin bundle's
 * `import ... from 'react'` resolves to the SAME React instance the host app
 * itself renders with (hooks/context correctness across the module boundary,
 * zero per-plugin author burden).
 *
 * The client namespace is the canonical public SDK module itself. React
 * Native renderers receive `PluginUiHostApi` through their render context;
 * this hosted-web client remains transport/bootstrap-bound and fails closed
 * when imported from a renderer without that boundary.
 */

let installed = false;

/**
 * Idempotent: safe to call on every RN-web loader construction. Real
 * (non-mocked) module namespaces — `react`/`react-native-web` are the SAME
 * instances the host app itself uses.
 */
export function installPluginUiHostRuntimeExternalsGlobal(
    globalScope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): void {
    if (installed && globalScope === globalThis as unknown as Record<string, unknown>) {
        return;
    }
    const runtime: PluginUiHostRuntimeExternalGlobalV1 = Object.freeze({
        react: React,
        'react/jsx-runtime': ReactJsxRuntime,
        'react/jsx-dev-runtime': ReactJsxDevRuntime,
        'react-native-web': ReactNativeWebNamespace,
        '@happier-dev/plugin-sdk/ui/client': PluginUiHostApiClient,
    });
    globalScope[PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY] = runtime;
    if (globalScope === globalThis as unknown as Record<string, unknown>) {
        installed = true;
    }
}

/** Test-only: reset the module-level idempotency guard between specs. */
export function resetPluginUiHostRuntimeExternalsGlobalForTesting(): void {
    installed = false;
}
