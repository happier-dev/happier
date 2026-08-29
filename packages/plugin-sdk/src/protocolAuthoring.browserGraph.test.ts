import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { pluginJsonValuesEqual as canonicalPluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import {
    defineProtocolObject as defineProtocolObjectFromPublicAuthoringEntry,
    defineProtocolUtf8String as defineProtocolUtf8StringFromPublicAuthoringEntry,
    pluginJsonValuesEqual,
} from './protocol/index.js';

const protocolBrowserEntry = resolve(import.meta.dirname, './protocol/index.browser.ts');
const protocolPublicEntry = resolve(import.meta.dirname, './protocol/index.public.ts');
const contributionsBrowserEntry = resolve(import.meta.dirname, './contributions/index.browser.ts');
const contributionsPublicEntry = resolve(import.meta.dirname, './contributions/index.public.ts');
const protocolRootEntry = resolve(import.meta.dirname, '../../protocol/src/index.ts');
const protocolJsonSchemaValidation = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/actions/jsonSchemaValidation.ts',
);
const protocolJsonSchemaTransitiveModules = [
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/jsonSchema.ts'),
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/jsonSchemaValues.ts'),
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/publicTypes.ts'),
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/strictJsonValue.ts'),
].sort();
const protocolComposerReferenceResolutionTransitiveModules = [
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/composerReferenceCandidateIdV1.ts'),
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/composerReferenceProviders.ts'),
    resolve(import.meta.dirname, '../../protocol/src/plugins/contributions/ui/tokens.ts'),
];
const protocolUiTargetedContributions = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/ui/targetedContributions.ts',
);
const protocolUiComposerRef = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/ui/composerRef.ts',
);
const protocolDataCollectionOpaqueCursor = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/data/collectionOpaqueCursorV1.ts',
);
const protocolComposerReferenceProviders = resolve(
    import.meta.dirname,
    '../../protocol/src/plugins/contributions/composerReferenceProviders.ts',
);

const expectedProtocolExports = [
    'ProtocolArrayOptions',
    'ProtocolCollectionOpaqueCursorV1',
    'ProtocolCollectionOpaqueCursorV1Schema',
    'ProtocolComposableSchema',
    'ProtocolComposerRefV1',
    'ProtocolComposerRefV1Schema',
    'ProtocolComposerReferenceResolutionV1Schema',
    'ProtocolJsonValue',
    'ProtocolJsonValueOptions',
    'ProtocolNumberOptions',
    'ProtocolObjectEvolutionPolicy',
    'ProtocolObjectOptions',
    'ProtocolSchemaInput',
    'ProtocolSchemaOutput',
    'ProtocolSchemaSafeParseResult',
    'ProtocolStringOptions',
    'ProtocolUtf8StringOptions',
    'ProtocolUniqueJsonArrayOptions',
    'ProtocolValidationError',
    'ProtocolValidationIssue',
    'defineProtocolArray',
    'defineProtocolJsonValue',
    'defineProtocolLiteral',
    'defineProtocolNumber',
    'defineProtocolObject',
    'defineProtocolString',
    'defineProtocolUnion',
    'defineProtocolUtf8String',
    'defineProtocolUniqueArray',
    'pluginJsonValuesEqual',
    'PluginJsonSchema',
].sort();
const expectedContributionExports = [
    'ContributionActionDangerLevel',
    'ContributionActionSurface',
    'ContributionAuthorDefinition',
    'ContributionAuthorTargets',
    'ContributionContributeInput',
    'ContributionOperationBindings',
    'ContributionOperationDefinition',
    'ContributionOperationRole',
    'ContributionPointAuthorDefinition',
    'ContributionPointOptions',
    'ContributionProtocol',
    'ContributionProtocolDefinition',
    'ContributionProtocolForPoint',
    'ContributionProtocolManifest',
    'ContributionSurfaceBinding',
    'ContributionSurfaceBindings',
    'ContributionSurfaceDefinition',
    'ContributionSurfaceFallback',
    'ContributionSurfaceHandle',
    'ContributionSurfaceIcon',
    'ContributionSurfaceLocalizedString',
    'ContributionSurfaceNode',
    'ContributionSurfaceNodeInput',
    'ContributionSurfacePresentation',
    'ContributionSurfaceRole',
    'DefinedContributionPointProtocolMap',
    'DescriptorFields',
    'IsRequiredSurfaceDefinition',
    'PluginTargetedContributionSelectionV1',
    'PluginTargetedContributionSelectionV1Schema',
    'PublicContributionProtocol',
    'PublicContributionProtocols',
    'RequiredSurfaceRoles',
    'SchemaInput',
    'SchemaOutput',
    'SurfaceFields',
    'defineContributionPoint',
    'defineContributionProtocol',
].sort();

function readNamedExports(path: string): readonly string[] {
    const source = readFileSync(path, 'utf8');
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const names: string[] = [];
    for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
        if (!ts.isNamedExports(statement.exportClause)) continue;
        names.push(...statement.exportClause.elements.map((element) => element.name.text));
    }
    return names.sort();
}

async function bundleProtocolAuthoring(): Promise<Readonly<{
    moduleIds: readonly string[];
    code: string;
}>> {
    const moduleIds = new Set<string>();
    const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: [
                {
                    find: '@happier-dev/protocol/plugins/contributions/composer-reference-providers',
                    replacement: protocolComposerReferenceProviders,
                },
                {
                    find: '@happier-dev/protocol/plugins/actions/json-schema-validation',
                    replacement: protocolJsonSchemaValidation,
                },
                {
                    find: '@happier-dev/protocol/plugins/ui/targetedContributions',
                    replacement: protocolUiTargetedContributions,
                },
                {
                    find: '@happier-dev/protocol/plugins/ui/composerRef',
                    replacement: protocolUiComposerRef,
                },
                {
                    find: '@happier-dev/protocol/plugins/data/collectionOpaqueCursorV1',
                    replacement: protocolDataCollectionOpaqueCursor,
                },
                {
                    // The graph is a source-level browser check; never let a stale
                    // workspace dist decide which Protocol exports it sees.
                    find: /^@happier-dev\/protocol$/u,
                    replacement: protocolRootEntry,
                },
            ],
        },
        plugins: [{
            name: 'protocol-authoring-browser-realm-entry',
            resolveId(id) {
                return id === 'virtual:protocol-authoring-browser-realm-entry' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:protocol-authoring-browser-realm-entry') return null;
                return [
                    `export { defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, defineProtocolUtf8String, defineProtocolUniqueArray, pluginJsonValuesEqual, ProtocolComposerRefV1Schema, ProtocolComposerReferenceResolutionV1Schema } from ${JSON.stringify(protocolBrowserEntry)};`,
                    `export { defineContributionPoint, defineContributionProtocol, PluginTargetedContributionSelectionV1Schema } from ${JSON.stringify(contributionsBrowserEntry)};`,
                ].join('\n');
            },
            generateBundle() {
                for (const id of this.getModuleIds()) moduleIds.add(id);
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: 'virtual:protocol-authoring-browser-realm-entry',
                preserveEntrySignatures: 'strict',
                output: {
                    format: 'es',
                    inlineDynamicImports: true,
                },
            },
        },
    });
    const outputs = (Array.isArray(result) ? result : [result])
        .flatMap((item) => ('output' in item ? item.output : []));
    const entry = outputs.find((item) => item.type === 'chunk' && item.isEntry);
    if (!entry || entry.type !== 'chunk') {
        throw new Error('Vite did not emit the protocol-authoring browser entry');
    }
    return { moduleIds: [...moduleIds], code: entry.code };
}

describe('protocol-authoring public browser entrypoint', () => {
    it('executes schema construction through the public protocol-authoring runtime entry', () => {
        const schema = defineProtocolObjectFromPublicAuthoringEntry({
            title: defineProtocolUtf8StringFromPublicAuthoringEntry({
                maxUtf8Bytes: 16,
                minLength: 1,
            }),
        }, { policy: 'closed' });

        expect(schema.safeParse({ title: 'ready' })).toEqual({
            success: true,
            data: { title: 'ready' },
        });
        expect(schema.safeParse({ title: '' }).success).toBe(false);
        expect(schema.safeParse({ title: 'é'.repeat(9) }).success).toBe(false);
    });

    it('projects the one canonical authoring spec into the browser realm', () => {
        expect(readFileSync(protocolBrowserEntry, 'utf8').trim())
            .toBe("export * from './index.public.js';");
    });

    it('re-exports strict Plugin JSON equality behavior without leaking its private source path', () => {
        expect(pluginJsonValuesEqual(
            { occurrenceId: 'occurrence-1', actor: { label: 'Ada', id: 'actor-1' } },
            { actor: { id: 'actor-1', label: 'Ada' }, occurrenceId: 'occurrence-1' },
        )).toBe(true);
        expect(pluginJsonValuesEqual(
            { occurrenceId: 'occurrence-1', actor: { label: 'Ada' } },
            { occurrenceId: 'occurrence-1', actor: { label: 'Ada Lovelace' } },
        )).toBe(false);
        expect(pluginJsonValuesEqual(
            { occurrenceId: 'occurrence-1', actor: { label: 'Ada', id: 'actor-1' } },
            { actor: { id: 'actor-1', label: 'Ada' }, occurrenceId: 'occurrence-1' },
        )).toBe(canonicalPluginJsonValuesEqual(
            { occurrenceId: 'occurrence-1', actor: { label: 'Ada', id: 'actor-1' } },
            { actor: { id: 'actor-1', label: 'Ada' }, occurrenceId: 'occurrence-1' },
        ));
    });

    it('publishes exactly the browser-safe schema and targeted-point authoring contract', () => {
        const packageJson = JSON.parse(readFileSync(
            new URL('../package.json', import.meta.url),
            'utf8',
        )) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./protocol']).toEqual({
            types: './dist/protocol/index.d.ts',
            browser: './dist/protocol/index.browser.js',
            default: './dist/protocol/index.js',
        });
        expect(packageJson.exports['./contributions']).toEqual({
            types: './dist/contributions/index.d.ts',
            browser: './dist/contributions/index.browser.js',
            default: './dist/contributions/index.js',
        });
        expect(readNamedExports(protocolPublicEntry)).toEqual(expectedProtocolExports);
        expect(readNamedExports(contributionsPublicEntry)).toEqual(expectedContributionExports);
    });

    it('keeps schema and point authoring browser-safe without service, runtime, or host exports', async () => {
        const { moduleIds, code } = await bundleProtocolAuthoring();

        expect(moduleIds).toContain(protocolBrowserEntry);
        expect(moduleIds).toContain(protocolPublicEntry);
        expect(moduleIds).toContain(contributionsBrowserEntry);
        expect(moduleIds).toContain(contributionsPublicEntry);
        expect(moduleIds).not.toContain(protocolRootEntry);
        expect(moduleIds).toContain(protocolUiTargetedContributions);
        // The composer-scope grammar reaches the browser-safe author surface
        // through its own narrow leaf. Publishing it from `plugins/ui/composer.ts`
        // instead would pull that module's renderer, token, attachment, media,
        // session-creation and voice graph into every feature-protocol bundle,
        // which the pinned list below is what catches.
        expect(moduleIds).toContain(protocolUiComposerRef);
        // The Collection cursor grammar reaches the browser-safe author
        // surface through its own narrow leaf. Publishing it from
        // `plugins/data/collectionUiQueryWireV1.ts` instead would pull Zod and
        // the contribution graph into every feature-protocol bundle, which the
        // pinned filters below are what catches.
        expect(moduleIds).toContain(protocolDataCollectionOpaqueCursor);
        const manifestOrContributionsModules = moduleIds
            .filter((id) => id.includes('/protocol/src/plugins/manifest/')
                || id.includes('/protocol/src/plugins/contributions/'))
            .sort();
        expect(manifestOrContributionsModules).toEqual([
            ...protocolJsonSchemaTransitiveModules,
            ...protocolComposerReferenceResolutionTransitiveModules,
        ].sort());
        expect(moduleIds.filter((id) => (
            id.includes('/plugin-sdk/src/services/')
            || id.includes('/plugin-sdk/src/runtime/')
            || id.includes('/plugin-sdk/src/host/')
            || id.includes('/protocol/src/plugins/ui/client.')
            || id.includes('/protocol/src/plugins/ui/hostApi')
            || id.includes('/protocol/src/plugins/ui/hostedWeb')
            || id.includes('/apps/')
            || id.startsWith('node:')
            || id.includes('__vite-browser-external')
        ))).toEqual([]);
        expect(code).not.toMatch(/(?:from\s*|import\s*\(|require\()\s*['"]node:/u);
        expect(code).not.toContain('__vite-browser-external');
    }, 60_000);
});
