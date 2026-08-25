import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const protocolLeaves = [
    {
        specifier: '@happier-dev/protocol/automations/result-delivery',
        source: '../../protocol/src/automations/automationResultDeliveryV1.ts',
        packageEntry: {
            types: './dist/automations/automationResultDeliveryV1.d.ts',
            default: './dist/automations/automationResultDeliveryV1.js',
        },
    },
    {
        specifier: '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1',
        source: '../../protocol/src/machines/administration/pluginMachineExecutionOriginV1.ts',
        packageEntry: {
            types: './dist/machines/administration/pluginMachineExecutionOriginV1.d.ts',
            default: './dist/machines/administration/pluginMachineExecutionOriginV1.js',
        },
    },
    {
        specifier: '@happier-dev/protocol/plugins/webhooks/endpointV1',
        source: '../../protocol/src/plugins/webhooks/endpointV1.ts',
        packageEntry: {
            types: './dist/plugins/webhooks/endpointV1.d.ts',
            default: './dist/plugins/webhooks/endpointV1.js',
        },
    },
    {
        specifier: '@happier-dev/protocol/plugins/webhooks/deliveryV1',
        source: '../../protocol/src/plugins/webhooks/deliveryV1.ts',
        packageEntry: {
            types: './dist/plugins/webhooks/deliveryV1.d.ts',
            default: './dist/plugins/webhooks/deliveryV1.js',
        },
    },
    {
        specifier: '@happier-dev/protocol/crypto/base64',
        source: '../../protocol/src/crypto/base64.ts',
        packageEntry: {
            types: './dist/crypto/base64.d.ts',
            default: './dist/crypto/base64.js',
        },
    },
    {
        specifier: '@happier-dev/protocol/plugins/data/collectionLimitsV1',
        source: '../../protocol/src/plugins/data/collectionLimitsV1.ts',
        packageEntry: {
            types: './dist/plugins/data/collectionLimitsV1.d.ts',
            default: './dist/plugins/data/collectionLimitsV1.js',
        },
    },
] as const;

const workspaceRequire = createRequire(pathToFileURL(resolve(
    import.meta.dirname,
    '../../../package.json',
)).href);

function readProtocolPackageJson(): Readonly<{ exports: Readonly<Record<string, unknown>> }> {
    return JSON.parse(readFileSync(
        new URL('../../protocol/package.json', import.meta.url),
        'utf8',
    )) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;
}

async function bundleSchemaProjections(): Promise<Readonly<{
    modules: ReadonlySet<string>;
    code: string;
}>> {
    const collectionsEntry = resolve(import.meta.dirname, './collections.ts');
    const automationsEntry = resolve(import.meta.dirname, './automations.ts');
    const executionOriginEntry = resolve(import.meta.dirname, './executionOrigin.ts');
    const webhooksEntry = resolve(import.meta.dirname, './webhooks.ts');
    const emittedModules = new Set<string>();
    const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: protocolLeaves.map(({ specifier, source }) => ({
                find: specifier,
                replacement: resolve(import.meta.dirname, source),
            })),
        },
        plugins: [{
            name: 'plugin-schema-projections-browser-realm-entry',
            resolveId(id) {
                return id === 'virtual:plugin-schema-projections-browser-realm-entry'
                    ? `\0${id}`
                    : null;
            },
            load(id) {
                if (id !== '\0virtual:plugin-schema-projections-browser-realm-entry') return null;
                return [
                    `export { AutomationResultDeliveryInputV1JsonSchema } from ${JSON.stringify(automationsEntry)};`,
                    `export { arePluginMachineExecutionOriginsEqual } from ${JSON.stringify(executionOriginEntry)};`,
                    `export { PluginMachineExecutionOriginV1JsonSchema } from ${JSON.stringify(collectionsEntry)};`,
                    `export { PluginWebhookActionInputSchema, PluginWebhookActionResultSchema, PluginWebhookEndpointIdV1Schema, PluginWebhookEndpointIdV1JsonSchema, PluginWebhookEndpointSetupV1Schema } from ${JSON.stringify(webhooksEntry)};`,
                ].join('\n');
            },
            generateBundle() {
                for (const id of this.getModuleIds()) emittedModules.add(id);
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: 'virtual:plugin-schema-projections-browser-realm-entry',
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
        throw new Error('Vite did not emit the SDK schema-projection browser entry');
    }
    return { modules: emittedModules, code: entry.code };
}

async function bundleMediaContractProjections(): Promise<Readonly<{
    modules: ReadonlySet<string>;
    code: string;
}>> {
    const uiEntry = resolve(import.meta.dirname, './ui/index.ts');
    const resourcesEntry = resolve(import.meta.dirname, './resources/index.ts');
    const protocolUiClient = resolve(import.meta.dirname, '../../protocol/src/plugins/ui/client.ts');
    const emittedModules = new Set<string>();
    const result = await build({
        configFile: false,
        logLevel: 'silent',
        resolve: {
            alias: [{
                find: '@happier-dev/protocol/plugins/ui/client',
                replacement: protocolUiClient,
            }],
        },
        plugins: [{
            name: 'plugin-media-contract-projections-browser-realm-entry',
            resolveId(id) {
                return id === 'virtual:plugin-media-contract-projections-browser-realm-entry'
                    ? `\0${id}`
                    : null;
            },
            load(id) {
                if (id !== '\0virtual:plugin-media-contract-projections-browser-realm-entry') return null;
                return [
                    `export { COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1, MAX_COMPOSER_CONTENT_INSPECT_BYTES_V1, MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1, ComposerContentInspectWireResultV1Schema, ComposerControlStateContentTypeV1Schema, ComposerControlStateV1Schema } from ${JSON.stringify(uiEntry)};`,
                    `export { MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1, MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1, PLUGIN_TRANSCRIPT_ACTIVITY_CONTENT_TYPE_V1, PluginTranscriptActivityResourceSnapshotV1Schema } from ${JSON.stringify(resourcesEntry)};`,
                ].join('\n');
            },
            generateBundle() {
                for (const id of this.getModuleIds()) emittedModules.add(id);
            },
        }],
        build: {
            minify: false,
            target: 'es2022',
            write: false,
            rollupOptions: {
                input: 'virtual:plugin-media-contract-projections-browser-realm-entry',
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
        throw new Error('Vite did not emit the SDK media-contract browser entry');
    }
    return { modules: emittedModules, code: entry.code };
}

describe('SDK Protocol schema projection browser graph', () => {
    it('publishes the exact canonical Protocol leaves needed by browser-facing SDK projections', () => {
        const protocolPackage = readProtocolPackageJson();

        for (const { specifier, packageEntry } of protocolLeaves) {
            expect(protocolPackage.exports).toHaveProperty(
                specifier.replace('@happier-dev/protocol/', './'),
                packageEntry,
            );
        }
    });

    it('resolves the exact canonical leaves from the workspace package entrypoints', async () => {
        const [
            automationResultDelivery,
            machineOrigin,
            webhookEndpoint,
            webhookDelivery,
            base64,
            collectionLimits,
        ] = await Promise.all(
            protocolLeaves.map(async ({ specifier }) => import(pathToFileURL(
                workspaceRequire.resolve(specifier),
            ).href)),
        );

        expect(automationResultDelivery).toHaveProperty('AutomationResultDeliveryInputV1JsonSchema');
        expect(automationResultDelivery).toHaveProperty('AutomationResultDeliveryInputV1Schema');
        expect(machineOrigin).toHaveProperty('PluginMachineExecutionOriginV1JsonSchema');
        expect(machineOrigin).toHaveProperty('arePluginMachineExecutionOriginsEqual');
        expect(webhookEndpoint).toHaveProperty('PluginWebhookEndpointIdV1Schema');
        expect(webhookEndpoint).toHaveProperty('PluginWebhookEndpointIdV1JsonSchema');
        expect(webhookEndpoint).toHaveProperty('PluginWebhookEndpointSetupV1Schema');
        expect(webhookDelivery).toHaveProperty('PluginWebhookActionInputV1Schema');
        expect(webhookDelivery).toHaveProperty('PluginWebhookActionResultV1Schema');
        expect(base64).toHaveProperty('decodeBase64');
        expect(collectionLimits).toHaveProperty('PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1');
        expect(collectionLimits).toHaveProperty('PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1');
    }, 30_000);

    it('keeps the SDK schema projections out of Protocol root and Node-only browser reach', async () => {
        const { modules, code } = await bundleSchemaProjections();
        const moduleIds = [...modules];

        expect(moduleIds.filter((id) => (
            id.includes('/protocol/src/index.')
            || id.includes('/protocol/dist/index.')
            || id.includes('node:')
            || id.includes('__vite-browser-external')
            || id.includes('/crypto/accountScopedCipher.')
            || id.includes('/tweetnacl/')
            || id.includes('/marketplace/marketplaceSourceRegistryV1.')
            || id.includes('/machines/peer/mediation/observability/metadataRedaction.')
        ))).toEqual([]);
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/machines/administration/pluginMachineExecutionOriginV1.ts',
        ));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/automations/automationResultDeliveryV1.ts',
        ));
        expect(moduleIds).toContain(resolve(import.meta.dirname, './automations.ts'));
        expect(moduleIds).toContain(resolve(import.meta.dirname, './executionOrigin.ts'));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/webhooks/endpointV1.ts',
        ));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/webhooks/deliveryV1.ts',
        ));
        expect(moduleIds).toContain(resolve(import.meta.dirname, '../../protocol/src/crypto/base64.ts'));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/data/collectionLimitsV1.ts',
        ));
        expect(moduleIds).not.toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/crypto/accountScopedCipherEnvelope.ts',
        ));
        expect(code).not.toContain('node:crypto');
        expect(code).not.toContain('__vite-browser-external');
    }, 60_000);

    it('keeps public media and transcript Resource contracts on the browser-safe Protocol UI client', async () => {
        const { modules, code } = await bundleMediaContractProjections();
        const moduleIds = [...modules];

        expect(moduleIds.filter((id) => (
            id.includes('/protocol/src/index.')
            || id.includes('/protocol/dist/index.')
            || id.includes('node:')
            || id.includes('__vite-browser-external')
        ))).toEqual([]);
        expect(moduleIds).toContain(resolve(import.meta.dirname, './ui/index.ts'));
        expect(moduleIds).toContain(resolve(import.meta.dirname, './resources/index.ts'));
        expect(moduleIds).toContain(resolve(import.meta.dirname, './ui/hostApi.ts'));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/ui/client.ts',
        ));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/runtime/input/composerContentV1.ts',
        ));
        expect(moduleIds).toContain(resolve(
            import.meta.dirname,
            '../../protocol/src/plugins/contributions/ui/transcriptActivities.ts',
        ));
        expect(code).not.toContain('node:');
        expect(code).not.toContain('__vite-browser-external');
    }, 60_000);
});
