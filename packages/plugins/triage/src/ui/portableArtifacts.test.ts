import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import * as ReactNative from 'react-native';
import * as PluginUi from '@happier-dev/plugin-ui';
import * as PluginUiComponents from '@happier-dev/plugin-ui/components';
import * as PluginUiData from '@happier-dev/plugin-ui/data';
import * as PluginUiDeclarative from '@happier-dev/plugin-ui/declarative';
import * as PluginUiEnvironment from '@happier-dev/plugin-ui/environment';
import * as PluginUiAdvanced from '@happier-dev/plugin-ui/advanced';
import * as PluginUiHostApi from '@happier-dev/plugin-ui/hostApi';

import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../cli-common/sourceRuntimeEntries.mjs';
import { evaluatePortableCommonJs } from '../../../../plugin-sdk/src/test-support/evaluatePortableCommonJs.js';
import { compileUniversalPluginUiCommonJs } from '../../../../plugin-sdk/src/ui/build/universalCommonJsCompiler.js';

// No Triage source is imported into this fresh worker before bundle evaluation:
// an ESM-preloaded source test can conceal CommonJS initialization cycles.
describe('Triage portable artifact initialization', () => {
    it.each([
        ['surface.tsx', 'renderSurface'],
        ['tasksSurface.tsx', 'renderSurface'],
        ['shell/root.tsx', 'TriageListShell'],
    ])('compiles and evaluates %s without preloading Triage', async (entry, symbol) => {
        const repoRoot = resolve(import.meta.dirname, '../../../../..');
        const packages = await readWorkspacePackages(repoRoot);
        const root = resolve(repoRoot, 'packages/plugins/triage');
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: root,
            entryPath: resolve(root, 'src/ui', entry),
            artifactId: `triage-${entry.replaceAll('/', '-')}`,
            requestedExports: [symbol],
            exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        const module = { exports: {} as Record<string, unknown> };
        const requireUi = createRequire(resolve(repoRoot, 'apps/ui/package.json'));
        const frameworkModules: Readonly<Record<string, unknown>> = {
            'react-native': ReactNative,
            'react-native-web': ReactNative,
            '@happier-dev/plugin-ui': PluginUi,
            '@happier-dev/plugin-ui/components': PluginUiComponents,
            '@happier-dev/plugin-ui/data': PluginUiData,
            '@happier-dev/plugin-ui/declarative': PluginUiDeclarative,
            '@happier-dev/plugin-ui/environment': PluginUiEnvironment,
            '@happier-dev/plugin-ui/advanced': PluginUiAdvanced,
            '@happier-dev/plugin-ui/hostApi': PluginUiHostApi,
        };
        evaluatePortableCommonJs(new TextDecoder().decode(result.bytes), module, (specifier) => {
            // The same real portable host namespaces supply imports, without
            // mounting a surface or preloading Triage source modules.
            if (specifier === 'react' || specifier === 'react/jsx-runtime'
                || specifier === 'react/jsx-dev-runtime') return requireUi(specifier);
            if (Object.hasOwn(frameworkModules, specifier)) return frameworkModules[specifier];
            throw new Error(`Unexpected framework import: ${specifier}`);
        });
        expect(module.exports[symbol]).toBeTypeOf('function');
    }, 120_000);
});
