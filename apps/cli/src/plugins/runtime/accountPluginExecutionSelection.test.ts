import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionInputV1Schema, PluginAvailabilityIntentReadActionOutputV1Schema,
    normalizePluginReleaseFactsV1 } from '@happier-dev/protocol/plugins/availability';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readCurrentAccountPluginExecutionSelection, readCurrentAccountPluginEnablements, resolveAccountPluginActivationSources } from './accountPluginActivationSource';
import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { createCommittedContributedActionInvoker } from './invocation/actions/createCommittedContributedActionDeps';
import { createBundledActivationSourceResolver } from './bundledActivationSource';

describe('captured Account execution selection transport', () => {
    it('reads Account enablement in the shared census and keeps missing intent default-on', async () => {
        const app = fastify();
        const pluginIds = ['happier.language.markdown', 'happier.language.typescript'];
        let reads = 0;
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => {
            reads += 1;
            return { availabilityCursor: 1, pluginIds, failedPluginIds: [], intentReads: pluginIds.map((pluginId, index) => ({ pluginId,
                response: { availabilityCursor: 1, hostingCapability: { enabled: false }, intent: index === 0 ? {
                    pluginId, desiredVersion: null, enabled: false, offlineUiHosting: 'disabled', writableCollections: [], revision: '1',
                } : null, release: null, uiArtifacts: [], packageAssets: [] },
            })) };
        });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-enablement.test' });
        try {
            expect(await readCurrentAccountPluginEnablements({ pluginIds, credentials: { token: 'account', encryption: null }, serverUrl: 'http://account-enablement.test' }))
                .toEqual(new Map([[pluginIds[0], false], [pluginIds[1], true]]));
            expect(reads).toBe(1);
        } finally { restore(); await app.close(); }
    });
    it.each(['release', 'disabled', 'machineDisabled'] as const)('resolves explicit Account %s without touching optional bundled bytes', async mode => {
        const app = fastify();
        const home = await mkdtemp(join(tmpdir(), 'account-override-'));
        const pluginId = 'com.acme.overridden-bundle';
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, entrypoints: {},
            contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }] } }));
        const response = PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: manifest.version, enabled: mode !== 'disabled',
                offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version }, normalizedManifest: manifest,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`, collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }),
            uiArtifacts: [], packageAssets: [] });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
            availabilityCursor: 1, pluginIds: [pluginId], intentReads: [{ pluginId, response }], failedPluginIds: [] }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://captured-home.test' });
        const packageName = '@happier-dev/plugins-overridden-bundle';
        const declaration = { pluginId, manifest, pluginRootPath: join(home, 'absent-bundled-root'),
            manifestPath: 'bundled:overridden', daemonEntryPath: null, devDaemonEntryPath: null,
            sourceSpec: { kind: 'bundled', locator: packageName, trustPolicy: 'prompt', installPolicy: 'copy' } as const };
        try {
            const source = await resolveAccountPluginActivationSources({
                contributes: createResolvedContributionRegistry(projectLoadedPluginContributes({ provenance: 'first_party',
                    loadResult: { loadedPlugins: [declaration], diagnosticsByPluginId: {} } })),
                machineEnabledById: { [pluginId]: mode !== 'machineDisabled' },
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'captured-account', encryption: null },
                serverUrl: 'http://captured-home.test', isCurrent: () => true,
                resolveBundledActivationSource: createBundledActivationSourceResolver({ bundledPackageNames: [packageName],
                    bundledDeclarations: [declaration] }),
            });
            expect(source.readSelection(pluginId)).toMatchObject(mode === 'release'
                ? { kind: 'available', sourceCustody: { kind: 'account_release' } } : { kind: 'unavailable', code: 'plugin_disabled' });
            expect(source.sourcesByPluginId.has(pluginId)).toBe(mode === 'release');
        } finally { restore(); await app.close(); await rm(home, { force: true, recursive: true }); }
    });
    it('retains an independently authored daemon-only source declaration beside an Account aggregate without granting it Account activation', async () => {
        const app = fastify();
        const home = await mkdtemp(join(tmpdir(), 'account-source-census-'));
        const targetId = 'com.acme.aggregate';
        const sourceId = 'com.acme.daemon-source';
        const targetDeclaration = normalizePluginManifestV2(definePlugin({ id: targetId, version: '1.0.0',
            displayName: 'Account aggregate', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
            hostAccess: { required: [], optional: [] }, contributionPoints: {
                sources: defineContributionProtocol({ id: 'external-source', version: 1,
                    descriptor: defineProtocolObject({ sourceId: defineProtocolString() }, { policy: 'additive-open/drop' }),
                    operations: { read: { required: true, input: { kind: 'contributorDefined' },
                        resultSchema: defineProtocolObject({}, { policy: 'closed' }),
                        action: { surfaces: ['plugin'], dangerLevel: 'safe' } } },
                }).point(),
            },
        }).manifest);
        const manifests = [normalizePluginManifestV2(createPluginManifestV2Fixture({ id: targetId, entrypoints: {},
            contributes: { pluginContributionPoints: targetDeclaration.contributes.pluginContributionPoints,
                actions: [{ id: 'list', title: 'List', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }] } })),
        normalizePluginManifestV2(createPluginManifestV2Fixture({ id: sourceId, contributes: {
            actions: [{ id: 'read', title: 'Read provider', scopes: ['global'], surfaces: ['plugin', 'cli'], dangerLevel: 'safe',
                resultSchema: { type: 'object' }, execution: { target: 'daemon' } }], targetedPluginContributions: [{ id: 'provider',
                target: { pluginId: targetId, pointId: 'sources' }, protocol: { id: 'external-source', version: 1 },
                descriptor: { sourceId: 'provider' }, operations: { read: 'read' } }],
        } }))];
        const reads = manifests.map(manifest => ({ pluginId: manifest.id,
            response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId: manifest.id, desiredVersion: manifest.version,
                    enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: normalizePluginReleaseFactsV1({ ref: { pluginId: manifest.id, version: manifest.version },
                    normalizedManifest: manifest, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }),
                uiArtifacts: [], packageAssets: [] }) }));
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
            availabilityCursor: 1, pluginIds: reads.map(read => read.pluginId), intentReads: reads, failedPluginIds: [] }));
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request =>
            reads.find(read => read.pluginId === PluginAvailabilityIntentReadActionInputV1Schema.parse(request.body).pluginId)?.response);
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://captured-home.test' });
        try {
            const source = await resolveAccountPluginActivationSources({ contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'captured-account', encryption: null },
                serverUrl: 'http://captured-home.test', isCurrent: () => true, resolveBundledActivationSource: () => null });
            expect(source.contributes.pluginDeclarations?.map(plugin => plugin.pluginId)).toEqual([targetId, sourceId]);
            expect(source.contributes.pluginDeclarations?.find(plugin => plugin.pluginId === sourceId)?.manifest.contributes.targetedPluginContributions)
                .toMatchObject([{ id: 'provider', operations: { read: 'read' } }]);
            expect(source.contributes.actions.find(action => action.pluginId === sourceId)?.definition.execution).toEqual({ target: 'daemon' });
            expect(source.contributes.activationTargets.map(target => target.pluginId)).toEqual([targetId]);
            expect(source.isCurrent(sourceId)).toBe(true);
            const registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: home,
                contributes: createResolvedContributionRegistry({}), accountExecution: {
                    credentials: { token: 'captured-account', encryption: null }, serverUrl: 'http://captured-home.test', isCurrent: () => true,
                } });
            try {
                const occurrence = registry.readPluginOccurrenceId?.(sourceId);
                expect(occurrence).toBeTruthy();
                expect(registry.readPluginSourceCustody?.(sourceId)).toMatchObject({ kind: 'account_release', pluginId: sourceId });
                expect(registry.readAdmittedTargetedContributions?.({ targetPluginId: targetId, pointId: 'sources',
                    protocol: { id: 'external-source', version: 1 } })?.contributions).toEqual([
                    expect.objectContaining({ descriptor: { sourceId: 'provider' },
                        operations: [expect.objectContaining({ role: 'read' })] }),
                ]);
                expect(await registry.activatePluginsForValidation?.([sourceId])).toEqual([]);
                expect(registry.isPluginOccurrenceCurrent?.(sourceId, occurrence!)).toBe(true);
                const lease = { registry, source: 'ephemeral' as const, durableRevision: -1, release: async () => {} };
                const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => lease });
                expect(await invoke({ action: { pluginId: sourceId, localId: 'read' }, input: {}, context: { surface: 'cli' } }))
                    .toMatchObject({ ok: false, errorCode: 'plugin_action_machine_required' });
            } finally { await registry.dispose(); }
        } finally { restore(); await app.close(); await rm(home, { force: true, recursive: true }); }
    });
    it.each(['release_replaced', 'account_retired'] as const)('retires the admitted source after %s without replaying a load', async reason => {
        const app = fastify();
        const home = await mkdtemp(join(tmpdir(), 'account-selection-'));
        const pluginId = 'com.acme.selection';
        let current = true;
        let version = '1.0.0';
        const read = () => {
            const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, version, entrypoints: {},
                contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['cli'],
                    dangerLevel: 'safe', execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }] } }));
            return PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
                hostingCapability: { enabled: false }, intent: { pluginId, desiredVersion: version, enabled: true,
                    offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: normalizePluginReleaseFactsV1({ ref: { pluginId, version }, normalizedManifest: manifest,
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } }),
                uiArtifacts: [], packageAssets: [] });
        };
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async () => ({
            availabilityCursor: 1, pluginIds: [pluginId], intentReads: [{ pluginId, response: read() }], failedPluginIds: [] }));
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => read());
        app.all('/v1/artifacts/*', async () => { throw new Error('Retired custody must not fetch or load bytes'); });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://captured-home.test' });
        try {
            const source = await resolveAccountPluginActivationSources({ contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), credentials: { token: 'captured-account', encryption: null },
                serverUrl: 'http://captured-home.test', isCurrent: () => current, resolveBundledActivationSource: () => null });
            expect(source.isCurrent(pluginId)).toBe(true);
            if (reason === 'release_replaced') version = '2.0.0'; else current = false;
            expect(await source.revalidate(pluginId)).toBe(false);
            expect(source.isCurrent(pluginId)).toBe(false);
            await expect(source.sourcesByPluginId.get(pluginId)?.resolveRelativeModule?.('portable')).rejects.toThrow('plugin_account_execution_retired');
        } finally { restore(); await app.close(); await rm(home, { force: true, recursive: true }); }
    });
    it('uses the captured Home and credentials and rejects a different plugin identity', async () => {
        const app = fastify();
        const home = await mkdtemp(join(tmpdir(), 'disabled-account-selection-'));
        const pluginId = 'com.acme.account';
        let returnedPluginId = pluginId;
        let httpStatus = 200;
        const response = () => PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: { pluginId: returnedPluginId, desiredVersion: null,
                enabled: false, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
            release: null, uiArtifacts: [], packageAssets: [] });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async (request, reply) => {
            expect(request.headers.authorization).toBe('Bearer captured-account');
            expect(request.body).toEqual({ pluginId });
            if (httpStatus !== 200) return reply.code(httpStatus).send({ error: 'Home unavailable' });
            return response();
        });
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async (_request, reply) =>
            httpStatus !== 200 ? reply.code(httpStatus).send({ error: 'Home unavailable' }) : {
                availabilityCursor: 1, pluginIds: [pluginId], intentReads: [{ pluginId, response: response() }], failedPluginIds: [] });
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://captured-home.test' });
        try {
            const input = { pluginId, credentials: { token: 'captured-account', encryption: null },
                serverUrl: 'http://captured-home.test' };
            expect(await readCurrentAccountPluginExecutionSelection(input)).toEqual({ kind: 'unavailable', code: 'plugin_disabled' });
            const source = await resolveAccountPluginActivationSources({ ...input, contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), isCurrent: () => true, resolveBundledActivationSource: () => null });
            expect(source.readSelection(pluginId)).toEqual({ kind: 'unavailable', code: 'plugin_disabled' });
            expect(source.sourcesByPluginId.has(pluginId)).toBe(false);
            expect(source.contributes.pluginDeclarations).toEqual([]);
            returnedPluginId = 'com.acme.other';
            await expect(readCurrentAccountPluginExecutionSelection(input)).rejects.toThrow('plugin_account_execution_identity_mismatch');
            httpStatus = 503;
            await expect(readCurrentAccountPluginExecutionSelection(input)).rejects.toMatchObject({ response: { status: 503 } });
            await expect(resolveAccountPluginActivationSources({ ...input, contributes: createResolvedContributionRegistry({}),
                paths: resolvePluginStorePaths({ happyHomeDir: home }), isCurrent: () => true, resolveBundledActivationSource: () => null }))
                .rejects.toMatchObject({ response: { status: 503 } });
        } finally { restore(); await app.close(); await rm(home, { force: true, recursive: true }); }
    });
});
