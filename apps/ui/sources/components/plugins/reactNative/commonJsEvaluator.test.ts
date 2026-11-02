import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { z } from 'zod/mini';
import * as Zod from 'zod';
import * as ZodCore from 'zod/v4/core';
import EnglishLocale from 'zod/v4/locales/en.js';
import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';
import { compileUniversalPluginUiCommonJs } from '../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';
import { packageNameOfSpecifier, readWorkspacePackages, resolveWorkspaceSource } from '../../../../../../packages/cli-common/sourceRuntimeEntries.mjs';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

import {
    PluginUiCommonJsEvaluationError,
    evaluatePluginUiCommonJsBundle,
} from './commonJsEvaluator';

const identity = Object.freeze({
    pluginId: 'example.plugin',
    artifactId: 'example-surface',
    digest: 'sha256:example',
});

const encoder = new TextEncoder();

describe('evaluatePluginUiCommonJsBundle', () => {
    it('evaluates compiled schemas using the same host Zod and Protocol identities', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-host-ui-schemas-'));
        try {
            const entryPath = join(root, 'entry.ts');
            await writeFile(entryPath, [
                "import { z } from 'zod/mini';",
                "import * as classic from 'zod';",
                "import * as core from 'zod/v4/core';",
                "import english from 'zod/v4/locales/en.js';",
                "import { ProtocolComposerRefV1Schema } from '@happier-dev/plugin-sdk/protocol';",
                'export const read = () => ({ string: z.string, classic: classic.string, core: core.$ZodError, english, composer: ProtocolComposerRefV1Schema, parsed: z.string().safeParse(42) });',
            ].join('\n'));
            const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../../..'));
            const result = await compileUniversalPluginUiCommonJs({
                projectRoot: root, entryPath, artifactId: 'host-schemas', requestedExports: ['read'],
                resolveSourceImport: (specifier) => specifier === 'zod/mini'
                    ? createRequire(import.meta.url).resolve('zod/mini')
                    : packages.has(packageNameOfSpecifier(specifier))
                        ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
            });
            const require = createRequire(import.meta.url);
            // Node resolves Zod's require/import export conditions separately;
            // Metro has one module namespace, so bridge the real ESM modules.
            const bridges = await Promise.all([
                loadVitestModuleForNodeRequire(pathToFileURL(require.resolve('@happier-dev/plugin-sdk/protocol')),
                    () => import(pathToFileURL(resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/protocol',
                        { conditions: ['react-native', 'browser'] })).href)),
                loadVitestModuleForNodeRequire(pathToFileURL(require.resolve('zod')), () => import('zod')),
                loadVitestModuleForNodeRequire(pathToFileURL(require.resolve('zod/v4/core')), () => import('zod/v4/core')),
                // Preserve Node/Metro's ESM marker rather than Vite's callable
                // default-import wrapper at this module-loader boundary.
                loadVitestModuleForNodeRequire(pathToFileURL(require.resolve('zod/v4/locales/en.js')),
                    async () => ({ __esModule: true, default: EnglishLocale })),
            ]);
            try {
                const read = evaluatePluginUiCommonJsBundle({ bytes: result.bytes, identity, requestedExport: 'read' });
                const value = read();
                if (!value || typeof value !== 'object') throw new Error('Missing authored schema projection');
                expect(Reflect.get(value, 'composer')).toBe(ProtocolComposerRefV1Schema);
                expect(value).toEqual({ string: z.string, classic: Zod.string, core: ZodCore.$ZodError, english: EnglishLocale, composer: ProtocolComposerRefV1Schema,
                    parsed: expect.objectContaining({ success: false }) });
                expect(result.externalSpecifiers).toEqual(['@happier-dev/plugin-sdk/protocol', 'zod', 'zod/mini', 'zod/v4/core', 'zod/v4/locales/en.js']);
            } finally {
                for (const bridge of bridges) bridge.dispose();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it('uses the production author-module map and refuses host-private presentation', () => {
        const read = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => Boolean(require("@happier-dev/plugin-ui") && require("@happier-dev/plugin-ui/components"));'),
            identity,
            requestedExport: 'read',
        });
        expect(read()).toBe(true);

        for (const specifier of [
            '@happier-dev/plugin-ui/presentation',
            '@happier-dev/plugin-ui/presentation/typeScale',
        ]) {
            expect(() => evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode(`require(${JSON.stringify(specifier)}); exports.read = () => true;`),
                identity,
                requestedExport: 'read',
            })).toThrowError(expect.objectContaining({ code: 'unknown_host_module' }));
        }
    });

    it('supports both CommonJS export forms and validates the requested callable export', () => {
        const first = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('module.exports = { renderSurface() { return "module"; } };'),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({}),
        });
        const second = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.renderSurface = () => "exports";'),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({}),
        });

        expect(first()).toBe('module');
        expect(second()).toBe('exports');
    });

    it('resolves exact host modules without prefix fallback', () => {
        const shared = Object.freeze({ value: 'shared' });
        const exported = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => require("host/exact").value;'),
            identity,
            requestedExport: 'read',
            hostModules: Object.freeze({ 'host/exact': shared }),
        });

        expect(exported()).toBe('shared');
        expect(() => evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => require("host/exact/subpath"); exports.read();'),
            identity,
            requestedExport: 'read',
            hostModules: Object.freeze({ 'host/exact': shared }),
        })).toThrowError(expect.objectContaining({ code: 'unknown_host_module' }));
    });

    it('fatally rejects malformed UTF-8 before executing any prefix', () => {
        const touched = { value: false };
        expect(() => evaluatePluginUiCommonJsBundle({
            bytes: new Uint8Array([
                ...encoder.encode('require("touch").run();'),
                0xc3,
                0x28,
            ]),
            identity,
            requestedExport: 'renderSurface',
            hostModules: Object.freeze({ touch: { run: () => { touched.value = true; } } }),
        })).toThrowError(expect.objectContaining({ code: 'module_instantiation_failed' }));
        expect(touched.value).toBe(false);
    });

    it('reports a missing or non-callable requested export without caching namespace state', () => {
        for (const source of ['module.exports = {};', 'exports.renderSurface = 42;']) {
            expect(() => evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode(source),
                identity,
                requestedExport: 'renderSurface',
                hostModules: Object.freeze({}),
            })).toThrowError(expect.objectContaining({ code: 'invalid_executable_export' }));
        }
    });

    it('isolates module and exports objects across concurrent evaluations', () => {
        const source = encoder.encode([
            'let count = 0;',
            'exports.increment = () => ++count;',
        ].join('\n'));
        const first = evaluatePluginUiCommonJsBundle({
            bytes: source,
            identity,
            requestedExport: 'increment',
            hostModules: Object.freeze({}),
        });
        const second = evaluatePluginUiCommonJsBundle({
            bytes: source,
            identity: { ...identity, artifactId: 'second' },
            requestedExport: 'increment',
            hostModules: Object.freeze({}),
        });

        expect(first()).toBe(1);
        expect(first()).toBe(2);
        expect(second()).toBe(1);
    });

    it('uses bounded diagnostics that never expose source or arbitrary thrown text', () => {
        try {
            evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode('throw new Error("secret plugin payload");'),
                identity,
                requestedExport: 'renderSurface',
                hostModules: Object.freeze({}),
            });
            throw new Error('expected evaluator failure');
        } catch (error) {
            expect(error).toBeInstanceOf(PluginUiCommonJsEvaluationError);
            expect(String(error)).not.toContain('secret plugin payload');
        }
    });
});
