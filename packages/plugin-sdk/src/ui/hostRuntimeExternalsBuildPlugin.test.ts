import { describe, expect, it } from 'vitest';
import { PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY } from '@happier-dev/protocol/plugins/ui';

import {
    createPluginUiHostRuntimeExternalsVitePlugin,
    generatePluginUiHostRuntimeExternalModuleSource,
} from './hostRuntimeExternalsBuildPlugin.js';

describe('generatePluginUiHostRuntimeExternalModuleSource', () => {
    it('emits a global-read guard and one static export per real named export', async () => {
        const source = await generatePluginUiHostRuntimeExternalModuleSource(
            'react',
            async () => ({ default: {}, useState: () => {}, useEffect: () => {}, Fragment: {} }),
        );

        expect(source).toContain(`globalThis[${JSON.stringify(PLUGIN_UI_HOST_RUNTIME_GLOBAL_KEY)}]`);
        expect(source).toContain('if (!__rt || !("react" in __rt))');
        expect(source).toContain('export const useState = __mod["useState"];');
        expect(source).toContain('export const useEffect = __mod["useEffect"];');
        expect(source).toContain('export const Fragment = __mod["Fragment"];');
        expect(source).not.toContain('export const default');
    });

    it('never enumerates unsafe/reserved binding names as named exports', async () => {
        const source = await generatePluginUiHostRuntimeExternalModuleSource(
            'react-native-web',
            async () => ({ 'not-a-valid-identifier': {}, View: {} }),
        );

        expect(source).not.toContain('not-a-valid-identifier');
        expect(source).toContain('export const View = __mod["View"];');
    });

    it('at runtime, throws a clear error when the host global is missing', async () => {
        const source = await generatePluginUiHostRuntimeExternalModuleSource(
            'react',
            async () => ({ useState: () => {} }),
        );
        // The generated source is real ESM (`export default`/`export const`), so
        // strip the export keywords to exec it as a plain function body — the
        // guard-throw logic itself is what's under test here, not ESM syntax.
        const executableBody = source.replace(/^export default /mu, 'return ').replace(/^export const \w+ = /mgu, 'void ');
        // eslint-disable-next-line no-new-func
        const runShim = new Function(executableBody);
        expect(() => runShim()).toThrow(/is not installed/);
    });
});

describe('createPluginUiHostRuntimeExternalsVitePlugin', () => {
    it('resolves only the configured specifiers to a virtual module id', () => {
        const plugin = createPluginUiHostRuntimeExternalsVitePlugin({
            specifiers: ['react', 'react-native-web'],
        });

        expect(plugin.resolveId('react')).toMatch(/^\0happier-plugin-host-runtime:react$/);
        expect(plugin.resolveId('react-native-web')).toMatch(/^\0happier-plugin-host-runtime:react-native-web$/);
        expect(plugin.resolveId('@happier-dev/plugin-sdk/ui/hostApiClient')).toBeNull();
        expect(plugin.resolveId('./local-module')).toBeNull();
    });

    it('loads generated source only for its own resolved virtual ids, using the injected real-module loader', async () => {
        const seenSpecifiers: string[] = [];
        const plugin = createPluginUiHostRuntimeExternalsVitePlugin({
            specifiers: ['react'],
            importRealModule: async (specifier) => {
                seenSpecifiers.push(specifier);
                return { useState: () => {} };
            },
        });

        const resolved = plugin.resolveId('react');
        expect(resolved).not.toBeNull();
        const loaded = await plugin.load(resolved as string);
        expect(loaded).toContain('export const useState = __mod["useState"];');
        expect(seenSpecifiers).toEqual(['react']);

        expect(await plugin.load('some-other-module-id')).toBeNull();
    });

    it('defaults to the canonical specifier list when none is provided', () => {
        const plugin = createPluginUiHostRuntimeExternalsVitePlugin();

        expect(plugin.resolveId('react')).not.toBeNull();
        expect(plugin.resolveId('react-native-web')).not.toBeNull();
        expect(plugin.resolveId('@happier-dev/plugin-sdk/ui/hostApiClient')).not.toBeNull();
    });
});

// FIX-RNWEB-SERVING: `defaultImportRealModule`'s bare `import(specifier)`
// resolves relative to THIS package's own compiled `dist/ui/...` location,
// never the consuming plugin author's project — a real, previously-
// unexercised defect (confirmed directly: `react` is not installed anywhere
// under `packages/plugin-sdk`, only under a real plugin author's own
// `node_modules`, e.g. `packages/plugins/inspector`). These tests exercise
// the REAL fix (`configResolved` capturing the author project's root) against
// a REAL installed dependency on disk — not an injected/mocked module — the
// same shape of gap the first real `vite build()` of the inspector's web
// artifact hit in this lane (`FIX-RNWEB-SERVING.md`).
describe('project-relative real-module resolution (configResolved)', () => {
    const inspectorPackageRoot = new URL('../../../plugins/inspector/', import.meta.url).pathname;

    it('resolves a default (non-injected) specifier against the project root reported by configResolved, not against plugin-sdk\'s own install location', async () => {
        const plugin = createPluginUiHostRuntimeExternalsVitePlugin({ specifiers: ['react'] });
        plugin.configResolved({ root: inspectorPackageRoot });

        const resolved = plugin.resolveId('react');
        expect(resolved).not.toBeNull();
        // This would reject with "Cannot find package 'react'" (the real
        // defect this lane found) if resolution still fell back to
        // plugin-sdk's own dist location instead of the inspector project's.
        const loaded = await plugin.load(resolved as string);
        expect(loaded).toMatch(/export const \w+ = __mod\[/u);
    });

    it('never lets configResolved override an explicitly injected importRealModule', async () => {
        const seenSpecifiers: string[] = [];
        const plugin = createPluginUiHostRuntimeExternalsVitePlugin({
            specifiers: ['react'],
            importRealModule: async (specifier) => {
                seenSpecifiers.push(specifier);
                return { useState: () => {} };
            },
        });
        plugin.configResolved({ root: inspectorPackageRoot });

        const resolved = plugin.resolveId('react');
        await plugin.load(resolved as string);
        expect(seenSpecifiers).toEqual(['react']);
    });
});
