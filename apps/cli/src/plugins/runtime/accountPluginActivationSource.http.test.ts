import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createBundledActivationSourceResolver } from './bundledActivationSource';
import { resolveAccountPluginActivationSources } from './accountPluginActivationSource';

describe('Account revalidation HTTP cost', () => {
    it('revalidates Account custody without transferring unconsumed Machine declarations per detail open', async () => {
        const home = await mkdtemp(join(tmpdir(), 'account-http-bytes-'));
        const app = fastify();
        const pluginId = 'happier.channels';
        const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [pluginId] }).loadedPlugins[0]!;
        // The retained Account census has 490 Machine declarations of about 128 KiB each.
        // Keep this source-shaped workload at the HTTP boundary; selection and parsing are real.
        const manifest = normalizePluginManifestV2({ schemaVersion: 2, id: pluginId, version: declaration.manifest.version,
            displayName: 'Scale-shaped declaration', engines: { happier: '^1.0.0' }, contributes: {},
            metadata: { body: 'x'.repeat(128 * 1024) } });
        let enabled = true;
        let reads = 0;
        let declarationBodies = 0;
        let bytes = 0;
        const response = () => ({ availabilityCursor: 1, hostingCapability: { enabled: false },
            intent: { pluginId, desiredVersion: null, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: null, uiArtifacts: [], packageAssets: [] });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
            availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [], intentReads: [{ pluginId, response: response() }] }));
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async (request, reply) => {
            const omit = typeof request.body === 'object' && request.body !== null && Reflect.get(request.body, 'omitDeclarations') === true;
            reads++;
            const body = JSON.stringify({ ...response(), ...(omit ? {} : { machineDeclarations: Array.from({ length: 490 }, (_, i) => ({
                machineId: 'machine-' + i, machineInstallationId: 'installation-' + i,
                declaration: { declarationDigestSha256: 'sha256:' + 'a'.repeat(64), manifest },
            })) }) });
            declarationBodies += omit ? 0 : 490;
            bytes += Buffer.byteLength(body);
            return reply.type('application/json').send(body);
        });
        const serverUrl = await app.listen({ host: '127.0.0.1', port: 0 });
        try {
            const source = await resolveAccountPluginActivationSources({
                contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                    loadResult: { loadedPlugins: [declaration], diagnosticsByPluginId: {} } })),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'fixture', encryption: null },
                serverUrl, isCurrent: () => true,
                resolveBundledActivationSource: createBundledActivationSourceResolver({ bundledDeclarations: [declaration],
                    bundledPackageNames: [declaration.sourceSpec.locator] }),
            });
            expect(source.readSelection(pluginId)).toMatchObject({ kind: 'available' });
            for (let i = 0; i < 4; i++) expect(await source.revalidate(pluginId)).toBe(true);
            console.info('ACCOUNT_REVALIDATION_HTTP_BYTES', JSON.stringify({ reads, declarationBodies, bytes }));
            expect(reads).toBe(4);
            expect(declarationBodies).toBe(0);
            expect(bytes).toBe(4 * Buffer.byteLength(JSON.stringify(response())));
            enabled = false;
            expect(await source.revalidate(pluginId)).toBe(false);
        } finally { await app.close(); await rm(home, { recursive: true, force: true }); }
    });
});
