import { expect, it, vi } from 'vitest';
import {
    DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonProjectionDeferredSectionsResponseSchema,
    DaemonProjectionSectionBodyResponseSchema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from '@/rpc/handlers/daemonContributionRegistryProjection';

it('keeps Describe pages local to their advertised revision and fitting bodies for 77 plugins and 616 Actions', async () => {
    // Same declaration scale and description length as fix-r390; this is a
    // constructed workload, not a claim about the current loaded Machine.
    const pluginIds = Array.from({ length: 77 }, (_, index) => `qa.paged-${index}`);
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
        plugins: pluginIds.map(id => ({
            manifest: createPluginManifestV2Fixture({ id, contributes: { actions: Array.from({ length: 8 }, (_, index) => ({
                id: `action-${index}`, title: `Action ${index}`, description: 'Action documentation '.repeat(512),
                execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['ui'], dangerLevel: 'safe', placementBindings: [],
                inputSchema: { type: 'object' },
            })) } }),
            files: { 'daemon.mjs': 'export function activate() {}' },
        })),
    });
    const runtime = fixture.registry;
    const rows: Record<string, unknown>[] = [];
    let catalogReads = 0;
    let featureReads = 0;
    let originContextReads = 0;
    let generation = runtime.generation!;
    const rpc = new RpcHandlerManager({ scopePrefix: 'r393', encryptionMode: 'plain', logger: () => {} });
    // Only external context/catalog providers are replaced. Spies below call
    // through: registry admission, projection, hashing and page framing are real.
    registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => runtime,
        resolveGeneration: async () => generation,
        resolveInstalledPackages: async () => { catalogReads++; return []; },
        resolveServerFeaturesSnapshot: () => { featureReads++; return undefined; },
        resolvePluginProjectionExecutionOriginContext: () => {
            originContextReads++;
            return { serverIdentityId: 'srv_r393', machineId: 'r393' };
        },
    });
    const read = (request: object) => rpc.invokeLocal(
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        { machineId: 'r393', locale: 'en', deferredSections: true, ...request });
    const stringify = vi.spyOn(JSON, 'stringify');
    const brands = vi.spyOn(runtime, 'getPluginBrandAsset');
    const custody = vi.spyOn(runtime, 'readPluginSourceCustody');
    const snapshot = () => ({ serializations: stringify.mock.calls.length, brands: brands.mock.calls.length,
        custody: custody.mock.calls.length, catalogReads, featureReads, originContextReads });
    const measure = async (phase: string, count: number, operation: () => Promise<unknown>) => {
        const before = snapshot();
        const started = performance.now();
        for (let index = 0; index < count; index++) await operation();
        const elapsedMs = performance.now() - started;
        const after = snapshot();
        const calls = stringify.mock.calls.slice(before.serializations, after.serializations);
        const serializedChars = stringify.mock.results.slice(before.serializations, after.serializations)
            .reduce((sum, result) => sum + (result.type === 'return' && typeof result.value === 'string' ? result.value.length : 0), 0);
        const fullProjectionSerializations = calls.filter(([value]) => value && typeof value === 'object'
            && 'projection' in value && value.projection && typeof value.projection === 'object'
            && 'actionsById' in value.projection && Object.keys(value.projection.actionsById).length === 616).length;
        const actionBodySerializations = calls.filter(([value]) => Array.isArray(value)
            && value.some(span => typeof span === 'string' && span.includes('Action documentation '))).length;
        const peerBodySerializations = calls.reduce((count, [value]) => count + (value && typeof value === 'object'
            && 'bodies' in value && Array.isArray(value.bodies) ? value.bodies.length : 0), 0);
        const row = { phase, count, elapsedMs, serializedChars, fullProjectionSerializations, actionBodySerializations,
            peerBodySerializations,
            serializations: after.serializations - before.serializations,
            brands: after.brands - before.brands, custody: after.custody - before.custody,
            catalogReads: after.catalogReads - before.catalogReads,
            featureReads: after.featureReads - before.featureReads,
            originContextReads: after.originContextReads - before.originContextReads };
        rows.push(row);
        return row;
    };
    try {
        invalidateDaemonContributionRegistryProjectionCache();
        let manifest: unknown;
        const cold = await measure('cold-manifest', 1, async () => { manifest = await read({}); });
        const admitted = DaemonProjectionDeferredSectionsResponseSchema.parse(manifest);
        const indexDigest = admitted.sections.actionsById!;
        let indexText = '';
        let offset: number | null = 0;
        let indexPages = 0;
        await measure('action-index', 1, async () => {
            while (offset !== null) {
                const page = DaemonProjectionSectionBodyResponseSchema.parse(await read({
                    sectionRead: { digest: indexDigest, offset },
                }));
                indexPages++;
                indexText += page.chunk;
                offset = page.nextOffset;
            }
        });
        const index: unknown = JSON.parse(indexText);
        if (!index || typeof index !== 'object' || !('parts' in index) || !Array.isArray(index.parts)) throw new Error('Missing Action index');
        const digests = index.parts.flatMap((part: unknown) => part && typeof part === 'object' && 'digest' in part
            && typeof part.digest === 'string' ? [part.digest] : []);
        expect(digests.length).toBeGreaterThan(0);
        expect(new Set(digests).size).toBe(digests.length);
        let bodyText = '';
        let bodyPages = 0;
        offset = 0;
        const body = await measure('one-action-body-all-pages', 1, async () => {
            while (offset !== null) {
                const page = DaemonProjectionSectionBodyResponseSchema.parse(await read({
                    sectionRead: { digest: digests[0], offset },
                }));
                bodyPages++;
                bodyText += page.chunk;
                offset = page.nextOffset;
            }
        });
        expect(JSON.parse(bodyText)).toEqual(expect.any(Array));
        const warmRows = [];
        for (const count of [1, 4, 16]) {
            warmRows.push(await measure('warm-first-body-page', count, () => read({
                sectionRead: { digest: digests[0], offset: 0 },
            })));
        }
        const peerRows = [];
        let firstPeerPage: unknown;
        for (const peerCount of [4, 16, digests.length - 1]) {
            peerRows.push(await measure(`warm-body-with-${peerCount}-peer-candidates`, 1, async () => {
                const page = DaemonProjectionSectionBodyResponseSchema.parse(await read({
                    sectionRead: { digest: digests[0], offset: 0,
                        includeDigests: digests.slice(1, peerCount + 1) },
                }));
                // Packing remains live: prepared byte lengths must not buy
                // zero work by suppressing peers that actually fit.
                if (peerCount === 4) expect(page.bodies?.length).toBeGreaterThan(0);
                if (firstPeerPage === undefined) firstPeerPage = page;
                else expect(page).toEqual(firstPeerPage);
            }));
        }
        expect(cold.fullProjectionSerializations).toBe(1);
        expect(cold.actionBodySerializations).toBe(616);
        expect(body.fullProjectionSerializations).toBe(0);
        expect(catalogReads).toBe(1);
        for (const row of warmRows) {
            expect(row.fullProjectionSerializations).toBe(0);
            expect(row.catalogReads).toBe(0);
        }
        // Positive control: a changed producer generation must
        // replace the projection, rather than buying zero work by serving stale data.
        const full = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await rpc.invokeLocal(
            RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { machineId: 'r393', locale: 'en' }));
        expect(Object.keys(full.projection.actionsById)).toHaveLength(616);
        invalidateDaemonContributionRegistryProjectionCache();
        const rebuilt = DaemonProjectionDeferredSectionsResponseSchema.parse(await read({}));
        expect(rebuilt.projectionDigest).toBe(admitted.projectionDigest);
        expect(rebuilt.sections).toEqual(admitted.sections);
        generation++;
        await measure('changed-generation-manifest', 1, async () => {
            const changed = DaemonProjectionDeferredSectionsResponseSchema.parse(await read({}));
            expect(changed.projectionDigest).not.toBe(admitted.projectionDigest);
        });
        rows.push({ indexPages, bodyPages, actionBodies: digests.length, plugins: pluginIds.length,
            actions: Object.keys(full.projection.actionsById).length, activatedPlugins: runtime.activatedPluginIds.size });
        for (const row of warmRows) {
            expect.soft(row.brands).toBe(0);
            expect.soft(row.originContextReads).toBe(0);
            expect.soft(row.custody).toBe(0);
        }
        for (const row of peerRows) {
            expect.soft(row.brands).toBe(0);
            expect.soft(row.originContextReads).toBe(0);
            expect.soft(row.peerBodySerializations).toBe(0);
            // These offers produce the same page: serialization work must be
            // independent of how many rejected candidates were offered.
            expect.soft(row.serializedChars).toBe(peerRows[0]!.serializedChars);
        }
    } finally {
        stringify.mockRestore(); brands.mockRestore(); custody.mockRestore();
        console.info('R393_WORK', JSON.stringify(rows));
        invalidateDaemonContributionRegistryProjectionCache();
        await fixture.dispose();
    }
}, 120_000);

it('serves an advertised narrow page while an unrelated full projection refresh is still preparing', async () => {
    const pluginId = 'qa.page-ordering';
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
            actions: [{ id: 'query', title: 'Query', execution: { target: 'daemon' }, scopes: ['global'],
                surfaces: ['ui'], dangerLevel: 'safe', placementBindings: [] }],
            searchProviders: [{ id: 'entries', action: 'query' }],
        } }), files: { 'daemon.mjs': 'export function activate() {}' },
    }] });
    let catalogReads = 0;
    let holdCatalog = false;
    let enterPreparation!: () => void;
    let releasePreparation!: () => void;
    const entered = new Promise<void>(resolve => { enterPreparation = resolve; });
    const held = new Promise<void>(resolve => { releasePreparation = resolve; });
    const rpc = new RpcHandlerManager({ scopePrefix: 'page-ordering', encryptionMode: 'plain', logger: () => {} });
    registerDaemonContributionRegistryProjectionHandler(rpc, {
        resolveRuntimeRegistry: async () => fixture.registry,
        resolveGeneration: async () => fixture.registry.generation,
        // The installed package reader is the filesystem boundary. Keep the
        // projection builder and both overlapping RPC requests real.
        resolveInstalledPackages: async () => {
            catalogReads++;
            if (holdCatalog) { enterPreparation(); await held; }
            return [];
        },
        resolveServerFeaturesSnapshot: () => undefined,
    });
    const read = (request: object = {}) => rpc.invokeLocal(
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        { machineId: 'page-ordering', locale: 'en', deferredSections: true,
            ...request });
    let fullRefresh: Promise<unknown> | undefined;
    try {
        invalidateDaemonContributionRegistryProjectionCache();
        const manifest = DaemonProjectionDeferredSectionsResponseSchema.parse(await read());
        const request = { sectionRead: { digest: manifest.sections.searchProviders!, offset: 0 } };
        const original = DaemonProjectionSectionBodyResponseSchema.parse(await read(request));
        expect(catalogReads).toBe(1);
        holdCatalog = true;
        invalidateDaemonContributionRegistryProjectionCache();
        let fullSettled = false;
        fullRefresh = read().finally(() => { fullSettled = true; });
        await entered;
        const beforePage = catalogReads;
        // Observe one event-loop turn, not a wall-clock latency threshold:
        // the page must settle while the independent preparation remains held.
        const pending = Symbol('page still pending');
        const outcome = await Promise.race([read(request), new Promise<symbol>(resolve => {
            setImmediate(() => resolve(pending));
        })]);
        expect(outcome).not.toBe(pending);
        expect(DaemonProjectionSectionBodyResponseSchema.parse(outcome)).toEqual(original);
        expect(catalogReads - beforePage).toBe(0);
        expect(fullSettled).toBe(false);
        releasePreparation();
        expect(DaemonProjectionDeferredSectionsResponseSchema.parse(await fullRefresh).projectionDigest)
            .toBe(manifest.projectionDigest);
    } finally {
        releasePreparation();
        await fullRefresh;
        invalidateDaemonContributionRegistryProjectionCache();
        await fixture.dispose();
    }
});
