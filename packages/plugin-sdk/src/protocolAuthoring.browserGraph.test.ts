import { resolve } from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { pluginJsonValuesEqual as canonicalPluginJsonValuesEqual } from '@happier-dev/protocol/plugins/actions/json-schema-validation';

import {
    defineProtocolObject as defineProtocolObjectFromPublicAuthoringEntry,
    defineProtocolUtf8String as defineProtocolUtf8StringFromPublicAuthoringEntry,
    pluginJsonValuesEqual,
} from './protocol/index.js';

const protocolBrowserEntry = resolve(import.meta.dirname, './protocol/index.browser.ts');
const contributionsBrowserEntry = resolve(import.meta.dirname, './contributions/index.browser.ts');
const protocolRootEntry = resolve(import.meta.dirname, '../../protocol/src/index.ts');
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
const protocolLaunchProfileId = resolve(import.meta.dirname, '../../protocol/src/profiles/v2/profileId.ts');
const protocolTriageEntryRef = resolve(import.meta.dirname, '../../protocol/src/tasks/entryRefV1.ts');

async function bundleProtocolAuthoring(): Promise<Readonly<{
    moduleIds: readonly string[];
    code: string;
}>> {
    const moduleIds = new Set<string>();
    const result = await build({
        configFile: resolve(import.meta.dirname, '../vitest.source.config.ts'),
        logLevel: 'silent',
        plugins: [{
            name: 'protocol-authoring-browser-realm-entry',
            resolveId(id) {
                return id === 'virtual:protocol-authoring-browser-realm-entry' ? `\0${id}` : null;
            },
            load(id) {
                if (id !== '\0virtual:protocol-authoring-browser-realm-entry') return null;
                return [
                    `export { defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, defineProtocolUtf8String, defineProtocolUniqueArray, pluginJsonValuesEqual, ProtocolComposerRefV1Schema, ProtocolComposerReferenceResolutionV1Schema, ProtocolLaunchProfileIdV2Schema, TriageEntryRefV1Schema } from ${JSON.stringify(protocolBrowserEntry)};`,
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

    // Exact browser inventories and conditions are owned by
    // browserExportProjection.test.ts, including missing/extra negative controls.
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

    it('keeps schema and point authoring browser-safe without service, runtime, or host exports', async () => {
        const { moduleIds, code } = await bundleProtocolAuthoring();

        expect(moduleIds).toContain(protocolBrowserEntry);
        expect(moduleIds).toContain(contributionsBrowserEntry);
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
        expect(moduleIds).toContain(protocolLaunchProfileId);
        expect(moduleIds).toContain(protocolTriageEntryRef);
        expect(moduleIds.some(id => id.includes('/triage-protocol/'))).toBe(false);
        const manifestOrContributionsModules = moduleIds
            .filter((id) => id.includes('/protocol/src/plugins/manifest/')
                || id.includes('/protocol/src/plugins/contributions/'))
            .sort();
        // The public browser surface now includes Project, Account Notice and
        // transfer schema facts too. Preserve the required narrow primitives,
        // while the forbidden-owner guard below enforces the realm boundary;
        // the canonical inventory suite owns the evolving complete census.
        expect(manifestOrContributionsModules).toEqual(expect.arrayContaining([
            ...protocolJsonSchemaTransitiveModules,
            ...protocolComposerReferenceResolutionTransitiveModules,
        ]));
        expect(moduleIds.filter((id) => (
            id.includes('/plugin-sdk/src/services/')
            || id.includes('/plugin-sdk/src/runtime/')
            || id.includes('/plugin-sdk/src/host/')
            || id.includes('/protocol/src/plugins/ui/client.')
            // Artifact capability requests share only the canonical method
            // vocabulary; negotiation and executable request admission stay out.
            || (id.includes('/protocol/src/plugins/ui/hostApi')
                && !id.endsWith('/hostApiDefinition.ts'))
            || id.includes('/protocol/src/plugins/ui/hostedWeb')
            || id.includes('/apps/')
            || id.startsWith('node:')
            || id.includes('__vite-browser-external')
        ))).toEqual([]);
        expect(code).not.toMatch(/(?:from\s*|import\s*\(|require\()\s*['"]node:/u);
        expect(code).not.toContain('__vite-browser-external');
    }, 60_000);
});
