import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { ApiMachineClient } from '@/api/apiMachine';
import type { Machine } from '@/api/types';
import { configuration } from '@/configuration';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';

describe('Machine recipe family-only describe selection', () => {
    it('projects exact selected revisions with only the receiving Machine metadata fact, retaining recipes when that fact is unavailable', async () => {
        const pluginId = 'com.example.selected-machine-recipes';
        const recipe = { revision: '1', title: 'Fonts', software: true as const,
            inputSchema: { type: 'object' as const, properties: { manager: { type: 'string' as const, enum: ['apt'] } },
                required: ['manager'], additionalProperties: false },
            inputHints: { fields: [{ path: 'manager', widget: 'select' as const,
                title: { key: 'software.manager', fallback: 'Package manager' },
                options: [{ value: 'apt', label: { key: 'software.manager.apt', fallback: 'APT' } }] }] },
            steps: [{ id: 'fonts', kind: 'package' as const, manager: { kind: 'input' as const, path: 'manager' }, packages: [{ name: 'fonts-dejavu-core' }] }],
            removeSteps: [{ id: 'remove-fonts', kind: 'package' as const, state: 'absent' as const,
                manager: { kind: 'input' as const, path: 'manager' }, packages: [{ name: 'fonts-dejavu-core' }] }],
        };
        const author = definePlugin({ id: pluginId, version: '1.0.0', machineRecipes: {
            fonts: recipe, ffmpeg: { ...recipe, revision: '2', title: 'FFmpeg' },
        } });
        const sharp = (await import('sharp')).default;
        const brandBytes = await sharp({ create: { width: 64, height: 64, channels: 4,
            background: { r: 20, g: 40, b: 80, alpha: 1 } } }).png().toBuffer();
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
            happyHomeDir: configuration.happyHomeDir, controller: pluginReloadController,
            plugins: [{ manifest: { ...author.manifest, entrypoints: { daemon: './daemon.mjs' },
                brand: { iconResourceId: 'brand-icon', monochrome: true },
                contributes: { ...author.manifest.contributes,
                    resources: [{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] } },
                files: { 'assets/brand.png': brandBytes, 'daemon.mjs': 'export function activate() {}\n' } }] });
        const machine: Machine = { id: 'selected-machine', encryptionMode: 'plain', metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0, metadata: { host: 'selected-host', platform: 'darwin', arch: 'arm64',
                happyCliVersion: 'dev', homeDir: '/users/selected', happyHomeDir: '/users/selected/.happier' } };
        const readyClient = new ApiMachineClient('fixture-token', machine);
        const unavailableClient = new ApiMachineClient('fixture-token', { ...machine, metadata: null });
        let client = readyClient;
        let metadataReads = 0;
        try {
            const handlers = new Map<string, RpcHandler>();
            const projectionOptions = {
                resolveGeneration: async () => fixture.registry.generation,
                readMachineMetadataSnapshot: (machineId: string) => {
                    if (machineId !== machine.id) return undefined;
                    metadataReads++;
                    return client.getMachineMetadataSnapshot();
                },
            };
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, projectionOptions);
            const ref = { pluginId, recipeId: 'fonts', revision: '1' };
            const declaration = fixture.registry.contributes.pluginDeclarations?.find(entry => entry.pluginId === pluginId);
            if (!declaration) throw new Error('Expected the exact admitted recipe source declaration');
            const source = { kind: declaration.sourceSpec.kind, locator: declaration.sourceSpec.locator };
            const brand = fixture.registry.getPluginBrandAsset?.(pluginId);
            expect(brand).toMatchObject({ state: 'available', resource: { pluginId, localId: 'brand-icon' } });
            let brandReads = 0;
            const familyContext = { registry: fixture.registry.contributes, generation: fixture.registry.generation,
                readPluginBrandAsset: (id: string) => { brandReads++; return fixture.registry.getPluginBrandAsset?.(id); } };
            const markedFamily = buildPluginProjectionFamilyV2(familyContext, machineRecipesProjectionFamily);
            expect(Object.values(markedFamily.entriesById)).toHaveLength(2);
            for (const entry of Object.values(markedFamily.entriesById)) {
                expect(entry).toMatchObject({ pluginVersion: '1.0.0', source, brand });
            }
            expect(brandReads).toBe(1);
            const fullProjection = buildPluginProjectionV2({ generation: fixture.registry.generation,
                registry: createResolvedContributionRegistry({ machineRecipes: fixture.registry.contributes.machineRecipes,
                    pluginDeclarations: [declaration], occurrenceIdsByPluginId: fixture.registry.contributes.occurrenceIdsByPluginId }),
                ...(brand ? { brandAssetsByPluginId: { [pluginId]: brand } } : {}),
            });
            expect(fullProjection.installedPackagesById[pluginId]).toMatchObject({ source, brand });
            expect(fullProjection.familiesById.machineRecipes?.entriesById[`${pluginId}/fonts`])
                .toMatchObject({ source, brand, pluginVersion: '1.0.0' });
            brandReads = 0;
            expect(fixture.registry.contributes.machineRecipes?.map(entry => entry.identity.localId)).toContain('ffmpeg');
            let unselectedBodyReads = 0;
            const selectedDemandRegistry = { ...fixture.registry.contributes,
                machineRecipes: fixture.registry.contributes.machineRecipes?.map(entry => entry.identity.localId !== 'ffmpeg' ? entry
                    : new Proxy(entry, { get(target, key, receiver) {
                        if (key === 'definition') {
                            unselectedBodyReads++;
                            throw new Error('An unselected recipe body was read');
                        }
                        return Reflect.get(target, key, receiver);
                    } })),
            };
            // Keep the real admitted entries and canonical parser/projector.
            // Project-all-then-filter would touch ffmpeg and fail here before
            // transport, even if its final output contained only fonts.
            for (const recipeRefs of [[ref], []]) {
                const family = buildPluginProjectionFamilyV2({ ...familyContext, registry: selectedDemandRegistry,
                    machineRecipeRefs: recipeRefs }, machineRecipesProjectionFamily);
                expect(Object.keys(family.entriesById)).toEqual(recipeRefs.length ? [`${pluginId}/fonts`] : []);
            }
            expect(unselectedBodyReads).toBe(0);
            expect(brandReads).toBe(1);
            const read = async (recipeRefs = [ref], machineId = machine.id) => DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers
                .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({ machineId, selection: 'machineRecipes', recipeRefs }));
            const selected = await read();
            expect(Object.keys(selected.projection.familiesById.machineRecipes?.entriesById ?? {})).toEqual([`${pluginId}/fonts`]);
            expect(selected.projection.familiesById.machineRecipes?.entriesById[`${pluginId}/fonts`])
                .toMatchObject({ pluginVersion: '1.0.0', source, brand, definition: { id: 'fonts', ...recipe } });
            expect(selected).toMatchObject({ machineRecipeTarget: { platform: 'darwin', arch: 'arm64' } });
            expect(metadataReads).toBe(1);
            expect((await read([{ ...ref, revision: 'missing' }])).projection.familiesById.machineRecipes?.entriesById).toEqual({});
            const noBodies = await read([]);
            expect(noBodies.projection.familiesById.machineRecipes?.entriesById).toEqual({});
            expect(noBodies).toMatchObject({ machineRecipeTarget: { platform: 'darwin', arch: 'arm64' } });
            client = unavailableClient;
            const withoutMetadata = await read();
            expect(Object.keys(withoutMetadata.projection.familiesById.machineRecipes?.entriesById ?? {})).toEqual([`${pluginId}/fonts`]);
            expect(withoutMetadata).not.toHaveProperty('machineRecipeTarget');
            const other = await read([ref], 'another-machine');
            expect(other).not.toHaveProperty('machineRecipeTarget');
            expect(metadataReads).toBe(4);

            client = readyClient;
            let releaseStarted!: () => void;
            let settleRelease!: () => void;
            const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
            const heldRelease = new Promise<void>(resolve => { settleRelease = resolve; });
            const acquire = pluginReloadController.tryAcquireRuntimeRegistry.bind(pluginReloadController);
            const acquireSpy = vi.spyOn(pluginReloadController, 'tryAcquireRuntimeRegistry').mockImplementation(() => {
                const lease = acquire();
                if (lease) {
                    const release = lease.release.bind(lease);
                    // Scheduling only: preserve the actual authored runtime,
                    // registry and controller-backed lease disposal.
                    vi.spyOn(lease, 'release').mockImplementation(async () => {
                        releaseStarted();
                        await heldRelease;
                        await release();
                    });
                }
                return lease;
            });
            let current = true;
            let verifications = 0;
            try {
                const pending = Promise.resolve(handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({
                    machineId: machine.id, selection: 'machineRecipes', recipeRefs: [ref],
                }, { signal: new AbortController().signal, machineAdmission: {
                    actorAccountId: 'actor', custodianAccountId: 'owner', machineId: machine.id,
                    installationId: 'installation', role: 'manage', encryptionMode: 'plain',
                }, verifyMachineAdmissionCurrent: async () => { verifications++; return current; } })).then(
                    value => ({ status: 'fulfilled' as const, value }),
                    error => ({ status: 'rejected' as const, error: error as unknown }),
                );
                await releasing;
                current = false;
                settleRelease();
                // An admitted finite read completes after disposal without asking Home again.
                expect(await pending).toMatchObject({ status: 'fulfilled', value: { machineRecipeTarget: { platform: 'darwin' } } });
                expect(verifications).toBe(0);
            } finally {
                settleRelease();
                acquireSpy.mockRestore();
            }
        } finally {
            await readyClient.shutdown();
            await unavailableClient.shutdown();
            await fixture.dispose();
        }
    });

    it('reads only current recipe data and distinguishes unavailable from available-empty', async () => {
        const pluginId = 'com.example.machine-selection';
        const author = definePlugin({ id: pluginId, version: '1.0.0', machineRecipes: {
            fonts: { revision: '1', title: 'Fonts',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                steps: [{ id: 'fonts', kind: 'package', manager: 'apt', packages: [{ name: 'fonts-dejavu-core' }] }],
            },
        }, roles: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`role-${index}`, {
            name: `Role ${index}`, instructions: '', runsAs: { kind: 'session' as const },
            workspaceWrites: 'deny' as const, secondOpinion: 'off' as const, enabled: true,
        }])) });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ manifest: author.manifest, files: {} }] });
        try {
            const coldReads: string[] = [];
            const counts = { catalog: 0, features: 0, native: 0, provenance: 0, environment: 0 };
            const current = fixture.registry.contributes;
            let recipes: typeof current.machineRecipes | undefined = current.machineRecipes;
            // Instrument the real admitted registry; no parser, projector or
            // lifecycle implementation is replaced. Every unrelated cold read
            // is observable even when it would produce an empty family.
            const registry = new Proxy({ ...current }, { get(target, key, receiver) {
                if (key === 'machineRecipes') return recipes;
                if (typeof key === 'string' && key !== 'occurrenceIdsByPluginId' && key !== 'pluginDeclarations') coldReads.push(key);
                return Reflect.get(target, key, receiver);
            } });
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => ({ ...fixture.registry, contributes: registry }),
                resolveGeneration: async () => fixture.registry.generation,
                resolveInstalledPackages: async () => { counts.catalog += 1; return []; },
                resolveServerFeaturesSnapshot: () => { counts.features += 1; return undefined; },
                resolveHostedWebFeatureDecision: () => { counts.native += 1; throw new Error('Unrelated native read'); },
                resolveReactNativeBundlesFeatureDecision: () => { counts.native += 1; throw new Error('Unrelated native read'); },
                resolvePluginProjectionExecutionOriginContext: () => { counts.provenance += 1; return null; },
                processEnv: new Proxy({}, { get() { counts.environment += 1; return undefined; } }),
            });
            const read = async () => DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handlers
                .get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!({ machineId: 'machine', selection: 'machineRecipes' }));
            const populated = await read().finally(() => {
                expect(coldReads).toEqual([]);
                expect(counts).toEqual({ catalog: 0, features: 0, native: 0, provenance: 0, environment: 0 });
            });
            expect(Object.keys(populated.projection.familiesById)).toEqual(['machineRecipes']);
            expect(populated.projection.familiesById.machineRecipes?.entriesById[`${pluginId}/fonts`])
                .toMatchObject({ pluginId, definition: { id: 'fonts', revision: '1' } });
            recipes = [];
            const empty = await read();
            expect(empty.projection.familiesById.machineRecipes).toEqual({ family: 'machineRecipes', entriesById: {} });
            recipes = undefined;
            const unavailable = await read();
            expect(unavailable.projection.familiesById.machineRecipes).toBeUndefined();
            for (const response of [populated, empty, unavailable]) {
                expect(response.projection.installedPackagesById).toEqual({});
                expect(response.projection.agentsById).toEqual({});
                expect(response.projection.actionsById).toEqual({});
                expect(response.projection.settingsById).toEqual({});
                expect(response.composerSurfaceCatalog).toBeUndefined();
                expect(response.automationEligibleEvents).toBeUndefined();
            }
            expect(coldReads).toEqual([]);
            expect(counts).toEqual({ catalog: 0, features: 0, native: 0, provenance: 0, environment: 0 });
        } finally { await fixture.dispose(); }
    });
});
