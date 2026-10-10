import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
    verifyPluginUiArtifactFileSetIntegrityV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { reloadConfiguration } from '@/configuration';
import { createResolvedContributionRegistry, getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

describe('bundled daemon contribution describe cost', () => {
    it('measures the real bundled response and keeps Artifact bytes and Action schemas out of describe', async () => {
        const previousHome = process.env.HAPPIER_HOME_DIR;
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'gi-describe-cost-'));
        process.env.HAPPIER_HOME_DIR = happyHomeDir;
        reloadConfiguration();
        invalidateDaemonContributionRegistryProjectionCache();
        const registry = getResolvedContributionRegistry();
        // Real host admission is required by the bundled SCM contributions;
        // excluding their plugin ids creates an invalid custody fixture.
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir, contributes: registry, generation: 1,
            resolveServerFeaturesSnapshot: () => undefined,
            // Environment registration is the boundary; manifest admission,
            // activation and source-custody propagation remain real.
            resolveDevelopmentSourceAuthority: ({ pluginId, rootPath }) => ({
                kind: 'development', registeredRootId: `describe-cost:${pluginId}`,
                canonicalRoot: rootPath, observedRevision: 1,
            }),
        });
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({
                registerHandler: (method, handler) => { handlers.set(method, handler); },
            }, {
                resolveRuntimeRegistry: async () => runtime,
                resolveGeneration: async () => 1,
                // This replaces only the server-features network boundary.
                resolveServerFeaturesSnapshot: async () => undefined,
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
            const full = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handler({ machineId: 'test-machine' }));
            const selected = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handler({ machineId: 'test-machine', selection: 'agents' }));
            const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
            const families = Object.fromEntries(Object.entries(full.projection).map(([id, value]) => [id, byteSize(value)]));
            console.info(JSON.stringify({ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                bytes: byteSize(full), agentSelectionBytes: byteSize(selected), families,
                automationEligibleEventsBytes: byteSize(full.automationEligibleEvents ?? null),
                composerSurfaceCatalogBytes: byteSize(full.composerSurfaceCatalog ?? null) }));
            expect(Object.keys(full.projection.actionsById).length).toBeGreaterThan(0);
            expect(selected.projection.agentsById).toEqual(full.projection.agentsById);
            expect(JSON.stringify(full).includes('"bytesBase64"')).toBe(false);
            // Automation setup Actions still carry the schemas their forms
            // consume. Only the general Action catalog uses targeted reads.
            expect(Object.values(full.projection.actionsById).some(action => (
                'inputSchema' in action || 'outputSchema' in action
            ))).toBe(false);
            expect(byteSize(selected)).toBeLessThan(byteSize(full));
            expect(await handler({ machineId: 'test-machine' })).toEqual(full);
        } finally {
            await runtime.dispose();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            invalidateDaemonContributionRegistryProjectionCache();
        }
    });

    it('returns verified Artifact metadata for less CPU than hashing it again', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'gi-artifact-cost-'));
        const relativePath = 'hosted-web/panel/index.html';
        const installedRoot = join(happyHomeDir, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
        await mkdir(join(installedRoot, 'hosted-web/panel'), { recursive: true });
        const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);
        await writeFile(join(installedRoot, relativePath), bytes);
        const files = [{ relativePath, bytes }];
        const digest = computePluginUiArtifactFileSetSha256DigestV1(files);
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'panel', tier: 'hostedWeb', entry: relativePath,
            files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
            digest, builtWith: { staging: 'staticDirectory' }, hostUiApiRange: '^1.0.0',
        });
        const registry = createResolvedContributionRegistry({ agents: [],
            occurrenceIdsByPluginId: { 'cost.plugin': createPluginRuntimeOccurrenceId('cost.plugin') },
            uiRenderersV2: [{ provenance: 'external', source: { kind: 'path' }, pluginId: 'cost.plugin',
                identity: { pluginId: 'cost.plugin', localId: 'panel-renderer' },
                manifestPath: join(happyHomeDir, '.happier-plugin/plugin.json'), pluginRootPath: happyHomeDir,
                generatedUiArtifactsManifest: { version: 2, entries: [graph] },
                definition: { id: 'panel-renderer', kind: 'hostedWeb', source: { kind: 'artifact', artifact: 'panel' } },
            }],
        });
        const runtime = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes: registry,
            generation: 1, pluginIds: [], resolveServerFeaturesSnapshot: () => undefined });
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } },
                { resolveRuntimeRegistry: async () => runtime });
            const request = { machineId: 'test-machine', artifactFamily: 'hostedWeb', cacheIdentity: { artifactDigest: digest } };
            const read = () => handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ)!(request);
            // Same filesystem-produced Buffer as the real RPC. Hashing a plain
            // Uint8Array instead would compare different native/JS workloads.
            // This comparator omits registry admission, so it is a lower
            // bound on the incumbent's cost, not an artificial extra workload.
            const incumbent = async () => {
                const resolved = await resolveContainedPluginResourcePath({ pluginRootPath: installedRoot, resourcePath: relativePath });
                if (!resolved) throw new Error('Artifact fixture path is not contained');
                const loadedBytes = await readFile(resolved.absolutePath);
                expect(computePluginUiArtifactSha256DigestV1(loadedBytes)).toBe(graph.files[0].digest);
                expect(verifyPluginUiArtifactFileSetIntegrityV1({ files: [{ relativePath, bytes: loadedBytes }], integrity: {
                    digest, pluginId: 'cost.plugin', contributionId: 'panel-renderer', artifactKind: 'hostedWebAsset',
                } }).ok).toBe(true);
                return DaemonPluginUiArtifactBytesReadResponseSchema.parse({ ok: true, artifactFamily: 'hostedWeb',
                    cacheIdentity: request.cacheIdentity, artifact: { artifactKind: 'hostedWebAsset', digest, byteSize: bytes.byteLength },
                    files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(loadedBytes), byteSize: loadedBytes.byteLength,
                        bytesBase64: Buffer.from(loadedBytes).toString('base64') }],
                });
            };
            const expected = await incumbent();
            expect(await read()).toEqual(expected);
            for (let warm = 0; warm < 10; warm += 1) { await read(); await incumbent(); }
            const samples = [];
            for (let sample = 0; sample < 3; sample += 1) {
                const currentStarted = process.cpuUsage();
                for (let iteration = 0; iteration < 12; iteration += 1) await read();
                const current = process.cpuUsage(currentStarted);
                const incumbentStarted = process.cpuUsage();
                for (let iteration = 0; iteration < 12; iteration += 1) await incumbent();
                const prior = process.cpuUsage(incumbentStarted);
                samples.push({ current: current.user + current.system, incumbent: prior.user + prior.system });
            }
            const median = (values: number[]) => values.sort((a, b) => a - b)[1];
            const currentCpuUs = median(samples.map(sample => sample.current));
            const incumbentCpuUs = median(samples.map(sample => sample.incumbent));
            console.info(JSON.stringify({ currentCpuUs, incumbentCpuUs, responseBytes: Buffer.byteLength(JSON.stringify(expected)),
                duplicatedResponseBytes: Buffer.byteLength(JSON.stringify({ ...expected, bytesBase64: Buffer.from(bytes).toString('base64') })) }));
            // One redundant hash out of three dominates this large-file
            // workload. Require a material reduction, not a noisy near-tie.
            expect(currentCpuUs).toBeLessThan(incumbentCpuUs * 0.75);
            // A new request must still catch mutable installed files; no cache
            // or second identity authority is introduced by metadata reuse.
            await writeFile(join(installedRoot, relativePath), new Uint8Array(bytes.length).fill(98));
            expect(await read()).toMatchObject({ ok: false, code: 'artifact_integrity_failed' });
        } finally { await runtime.dispose(); }
    });
});
