import { describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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
import { PLUGIN_UI_COMMON_JS_HOST_MODULES } from './hostModules';
import { loadVitestModuleForNodeRequire } from '@/dev/vitestRnShim';

import {
    PluginUiCommonJsEvaluationError,
    evaluatePluginUiCommonJsBundle,
    instantiatePluginUiCommonJsBundle,
} from './commonJsEvaluator';

const identity = Object.freeze({
    pluginId: 'example.plugin',
    artifactId: 'example-surface',
    digest: 'sha256:example',
});

const encoder = new TextEncoder();

describe('evaluatePluginUiCommonJsBundle', () => {
    it('runs the Triage PR view filter through the browser-selected public Task identity', async () => {
        const repoRoot = resolve(import.meta.dirname, '../../../../../..');
        const packages = await readWorkspacePackages(repoRoot);
        const root = await mkdtemp(join(tmpdir(), 'happier-triage-browser-identity-'));
        try {
            const entryPath = join(root, 'entry.ts');
            await writeFile(entryPath, [
                `import { TRIAGE_PR_VIEW_INVENTORY_V1 as view } from ${JSON.stringify(join(repoRoot, 'packages/plugins/triage/src/ui/list/viewInventory.ts'))};`,
                "import { INTERNAL_TASK_SOURCE_V1 as source, internalTaskLocalRefV1, internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1 } from '@happier-dev/plugin-sdk/protocol';",
                'export function read() { const ref = { source, ...internalTaskLocalRefV1("task-1", "owner") }; return { task: view.includesSource(source), other: view.includesSource({ pluginId: "acme.issues", localId: "issues" }), isTask: isInternalTaskReferenceV1(ref), owner: internalTaskOwnerAccountIdV1(ref, "viewer") }; }',
            ].join('\n'));
            const result = await compileUniversalPluginUiCommonJs({
                projectRoot: root, entryPath, artifactId: 'triage-browser-identity', requestedExports: ['read'],
                resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                    ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
            });
            const browserSource = resolveWorkspaceSource(packages, '@happier-dev/plugin-sdk/protocol', { conditions: ['react-native', 'browser'] });
            const bridge = await loadVitestModuleForNodeRequire(
                pathToFileURL(createRequire(import.meta.url).resolve('@happier-dev/plugin-sdk/protocol')),
                () => import(pathToFileURL(browserSource).href));
            try {
                const read = evaluatePluginUiCommonJsBundle({ bytes: result.bytes, identity, requestedExport: 'read' });
                expect(read()).toEqual({ task: false, other: true, isTask: true, owner: 'owner' });
            } finally {
                bridge.dispose();
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it.each([
        ['triage-account-runtime', 'src/accountRuntime.ts', 'activate'],
        ['triage-latest-widget-native', 'src/ui/widget/latestWidget.tsx', 'renderSurface'],
        ['triage-list-page-native', 'src/ui/surface.tsx', 'renderSurface'],
        ['triage-scm-pull-request-native', 'src/ui/scmPullRequestCard.tsx', 'renderSurface'],
        ['triage-session-pull-request-native', 'src/ui/sessionPullRequestWidget.tsx', 'renderSurface'],
        ['triage-session-entries-native', 'src/sessions/cockpit/sessionLinkedEntriesSurface.tsx', 'renderSurface'],
    ])('evaluates %s without duplicating host schema modules', async (artifactId, entryPath, requestedExport) => {
        const repoRoot = resolve(import.meta.dirname, '../../../../../..');
        const packages = await readWorkspacePackages(repoRoot);
        const result = await compileUniversalPluginUiCommonJs({
            projectRoot: join(repoRoot, 'packages/plugins/triage'), entryPath, artifactId,
            requestedExports: [requestedExport], exportConditions: ['happier-source'],
            resolveSourceImport: (specifier) => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        const retained = Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
            .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path));
        // Include SDK protocol facades as well as Protocol and Zod internals:
        // those facades now come from the same host-owned public SDK modules.
        const duplicates = retained.filter(path => /(?:^|[/\\])(?:zod|protocol)(?:[/\\]|@)/u.test(path));
        // Vitest imports source through Vite; Metro's literal call-time require
        // shares that source namespace through the canonical Node boundary bridge.
        const preparationStarted = performance.now();
        const bridges = await Promise.all(result.externalSpecifiers
            .filter(specifier => /^@happier-dev\/(?:plugin-sdk|plugin-ui|protocol)(?:\/|$)/u.test(specifier))
            .map(specifier => loadVitestModuleForNodeRequire(pathToFileURL(createRequire(import.meta.url).resolve(specifier)),
                () => import(pathToFileURL(resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] })).href))));
        const hostModulePreparationMs = performance.now() - preparationStarted;
        try {
            const hostStarted = performance.now();
            for (const specifier of result.externalSpecifiers) {
                expect(PLUGIN_UI_COMMON_JS_HOST_MODULES[specifier as keyof typeof PLUGIN_UI_COMMON_JS_HOST_MODULES]).toBeDefined();
            }
            const hostResolutionMs = performance.now() - hostStarted;
            const started = performance.now();
            const instance = instantiatePluginUiCommonJsBundle({ bytes: result.bytes, identity: { ...identity, artifactId }, requestedExport });
            const evaluationMs = performance.now() - started;
            expect(instance.readExport(requestedExport)).toBeTypeOf('function');
            console.info('PLUGIN_UI_HOST_EVALUATION_MEASUREMENT', JSON.stringify({ artifactId,
                bytes: result.bytes.byteLength, duplicates: duplicates.length, hostModulePreparationMs, hostResolutionMs, evaluationMs, externalSpecifiers: result.externalSpecifiers,
            }));
            expect(duplicates).toHaveLength(0);
        } finally {
            for (const bridge of bridges) bridge.dispose();
        }
    });
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
    it('uses the production author-module map and refuses host-private presentation', async () => {
        const read = evaluatePluginUiCommonJsBundle({
            bytes: encoder.encode('exports.read = () => Boolean(require("@happier-dev/plugin-ui") && require("@happier-dev/plugin-ui/components"));'),
            identity,
            requestedExport: 'read',
        });
        // The host map loads these families on first require (Metro's call-time require).
        const packages = await readWorkspacePackages(resolve(import.meta.dirname, '../../../../../..'));
        const bridges = await Promise.all(['@happier-dev/plugin-ui', '@happier-dev/plugin-ui/components'].map(specifier => loadVitestModuleForNodeRequire(
            pathToFileURL(createRequire(import.meta.url).resolve(specifier)),
            () => import(pathToFileURL(resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] })).href))));
        try {
            expect(read()).toBe(true);
        } finally {
            for (const bridge of bridges) bridge.dispose();
        }

        for (const specifier of [
            '@happier-dev/plugin-ui/presentation',
            '@happier-dev/plugin-ui/presentation/typeScale',
            '@happier-dev/protocol/not/provided',
        ]) {
            expect(() => evaluatePluginUiCommonJsBundle({
                bytes: encoder.encode(`require(${JSON.stringify(specifier)}); exports.read = () => true;`),
                identity,
                requestedExport: 'read',
            })).toThrowError(expect.objectContaining({ code: 'unknown_host_module', specifier }));
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

    it('does not keep the artifact bytes alive through the instantiated module', async () => {
        setFlagsFromString('--expose-gc');
        const collect: () => void = runInNewContext('gc');
        setFlagsFromString('--no-expose-gc');
        const padding = ' '.repeat(8 * 1024 * 1024);
        let bytes: Uint8Array | null = encoder.encode(`module.exports.render = () => require('react');/*${padding}*/`);
        const released = new WeakRef(bytes.buffer);
        const module = instantiatePluginUiCommonJsBundle({ bytes, identity, requestedExport: 'render' });
        bytes = null;
        // A WeakRef keeps its target for the rest of the job that created it.
        await new Promise(resolve => setTimeout(resolve, 0));
        collect();
        expect(typeof module.readExport('render')).toBe('function');
        // Compare a boolean: printing a retained 8 MiB buffer in a failure diff exhausts the worker heap.
        expect(released.deref() === undefined).toBe(true);
    });
});
