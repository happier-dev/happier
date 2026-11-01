import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema,
    DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
    verifyPluginUiArtifactFileSetIntegrityV1 } from '@happier-dev/protocol/plugins/ui/artifactIntegrity';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmStatusSnapshotResponse } from '@happier-dev/protocol/scm';
import { readDeclaredConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { definePlugin } from '@happier-dev/plugin-sdk';
import type { RpcHandler } from '@/api/rpc/types';
import { reloadConfiguration } from '@/configuration';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { resolveDefaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import { createHostScmHostingProviderRuntimeServices } from '@/scm/hostingProviders/runtimeServices';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { resolveContainedPluginResourcePath } from '@/plugins/projection/resources/package/resolve';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

describe('bundled daemon contribution describe cost', () => {
    it('keeps authored SCM declarations cold through full describe and acquires native registrations only for an operation', async () => {
        const pluginId = 'acme.cold-scm';
        const failedPluginId = 'acme.failed-scm';
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{
            manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
                scmBackends: [{ id: 'stacked', title: 'Authored SCM', description: 'Cold backend metadata',
                    kind: 'acme', capabilities: ['detect', 'status'], metadata: { routing: 'stacked' } }],
                scmHostingProviders: [{ id: 'forge', title: 'Authored Forge', kind: 'acme', capabilities: ['detect'] }],
            } }),
            files: { 'daemon.mjs': `export function activate(api) {
                api.scm.registerHostingProvider('forge', { adapter: { routing: {
                    detectRemote: () => ({ id: 'forge', kind: 'acme', displayName: 'Authored Forge',
                        baseUrl: 'https://forge.example', repositoryWebUrl: 'https://forge.example/acme/repo' }),
                    buildCompareUrl: () => null,
                } } });
                api.scm.registerBackend('stacked', { runtime: {
                    repoModes: ['.git'], commands: [], capabilities: {
                        detection: { repository: { support: 'supported' } }, read: { status: { support: 'supported' } },
                        changeSet: { model: 'working-copy', diffAreas: ['pending'] }, commit: {}, remote: {}, branch: {},
                        worktree: {}, lifecycle: {}, hosting: {}, checkpoints: {}, workspaceIntegration: {}, tooling: {}, freshness: {},
                    },
                }, handlers: {
                    detection: { detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }) },
                    read: { statusSnapshot: async () => ({ success: true, branch: 'authored/main' }) },
                } });
            }` },
        }, {
            manifest: createPluginManifestV2Fixture({ id: failedPluginId, contributes: {
                scmBackends: [{ id: 'broken', title: 'Declared but failed SCM', kind: 'acme', capabilities: ['detect', 'status'] }],
            } }),
            files: { 'daemon.mjs': "export function activate() { throw new Error('authored SCM activation failed'); }" },
        }] });
        const runtime = fixture.registry;
        const retained: { invokeStatus?: () => Promise<ScmStatusSnapshotResponse> } = {};
        try {
            expect(runtime.activatedPluginIds.has(pluginId)).toBe(false);
            expect(runtime.activatedPluginIds.has(failedPluginId)).toBe(false);
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => runtime,
                resolveInstalledPackages: async () => [],
                resolveServerFeaturesSnapshot: () => undefined,
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            if (!handler) throw new Error('Expected the full describe handler');
            const describe = async () => DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handler({ machineId: 'scm-machine' }));
            const cold = await describe();
            expect(cold.projection.familiesById.scmBackends?.entriesById).toMatchObject({
                [`${pluginId}/stacked`]: { displayName: 'Authored SCM', description: 'Cold backend metadata',
                    operations: ['detect', 'status'], metadata: { routing: 'stacked' } },
                [`${failedPluginId}/broken`]: { displayName: 'Declared but failed SCM', operations: ['detect', 'status'] },
            });
            expect(cold.projection.familiesById.scmHostingProviders?.entriesById[`${pluginId}/forge`])
                .toMatchObject({ displayName: 'Authored Forge', operations: ['detect'] });
            // Full discovery still contains the UI/browser families Home consumes.
            expect(cold.projection.familiesById.pluginUi).toBeDefined();
            expect(cold.projection.familiesById.pluginBrowser).toBeDefined();
            expect(runtime.activatedPluginIds.has(pluginId)).toBe(false);
            expect(runtime.activatedPluginIds.has(failedPluginId)).toBe(false);
            expect(runtime.scmBackendsById?.size).toBe(0);
            expect(runtime.scmHostingProvidersById.size).toBe(0);

            const registry = await resolveDefaultScmBackendRegistry({ pluginRuntimeRegistry: runtime });
            const status = (backendId: string) => runScmRoute({
                request: { cwd: fixture.happyHomeDir, backendPreference: { kind: 'prefer', backendId } },
                workingDirectory: fixture.happyHomeDir,
                registry,
                onNonRepository: (): ScmStatusSnapshotResponse => ({ success: false }),
                runWithBackend: async ({ context, selection }) => {
                    if (!selection.backend.statusSnapshot) throw new Error('Expected the authored status operation');
                    retained.invokeStatus = () => selection.backend.statusSnapshot!({ context, request: { cwd: fixture.happyHomeDir } });
                    return await retained.invokeStatus();
                },
            });
            await expect(status(`${pluginId}/stacked`)).resolves.toMatchObject({ success: true, branch: 'authored/main' });
            expect(runtime.activatedPluginIds.has(pluginId)).toBe(true);
            const hosting = createHostScmHostingProviderRuntimeServices({
                contributes: runtime.contributes, scmHostingProvidersById: runtime.scmHostingProvidersById,
                envAllowedNamesByPluginId: runtime.envAllowedNamesByPluginId, managedDependencies: runtime.managedDependencies,
            });
            const hostingRegistry = await hosting.resolveScmHostingProviderRegistry?.();
            expect(hostingRegistry?.detectRemote({ remoteName: 'origin', remoteUrl: 'https://forge.example/acme/repo' }))
                .toMatchObject({ kind: 'resolved', providerId: `${pluginId}/forge` });

            await expect(status(`${failedPluginId}/broken`)).resolves.toMatchObject({ success: false, errorCode: 'BACKEND_UNAVAILABLE' });
            const diagnostics = runtime.pluginDiagnosticsByPluginId[failedPluginId] ?? [];
            expect(diagnostics.length).toBeGreaterThan(0);
            const afterFailure = await describe();
            expect(afterFailure.projection.familiesById.scmBackends?.entriesById[`${failedPluginId}/broken`])
                .toMatchObject({ displayName: 'Declared but failed SCM' });
            expect(afterFailure.projection.diagnostics).toEqual(expect.arrayContaining(diagnostics.map(({ code }) =>
                expect.objectContaining({ plugin: expect.objectContaining({ id: failedPluginId }),
                    data: expect.objectContaining({ code }) }))));
        } finally { await fixture.dispose(); }
        if (!retained.invokeStatus) throw new Error('Expected a retained native SCM operation');
        await expect(retained.invokeStatus()).rejects.toThrow(/no longer active/);
    });

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
        // Diagnostic timestamps are supplied by the system clock on every read.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        try {
            const handlers = new Map<string, RpcHandler>();
            let serverFeatureReads = 0;
            let installedPackageReads = 0;
            let executionOriginContextReads = 0;
            let serverIdentityId: string | null = 'srv_cost';
            let blockedCatalogRead: Readonly<{ entered(): void; wait: Promise<void> }> | undefined;
            const blockNextCatalogRead = () => {
                let enterCatalog = () => {};
                let release = () => {};
                const entered = new Promise<void>(resolve => { enterCatalog = resolve; });
                const wait = new Promise<void>(resolve => { release = resolve; });
                blockedCatalogRead = { entered: enterCatalog, wait };
                return { entered, release };
            };
            registerDaemonContributionRegistryProjectionHandler({
                registerHandler: (method, handler) => { handlers.set(method, handler); },
            }, {
                resolveRuntimeRegistry: async () => runtime,
                resolveGeneration: async () => 1,
                resolveInstalledPackages: async () => {
                    installedPackageReads += 1;
                    const blocked = blockedCatalogRead;
                    blockedCatalogRead = undefined;
                    if (blocked) { blocked.entered(); await blocked.wait; }
                    return [];
                },
                resolvePluginProjectionExecutionOriginContext: async () => {
                    executionOriginContextReads += 1;
                    return serverIdentityId === null ? null : { serverIdentityId, machineId: 'test-machine' };
                },
                // This replaces only the server-features network boundary.
                resolveServerFeaturesSnapshot: async () => { serverFeatureReads += 1; return undefined; },
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
            const readScmRegistrations = () => ({
                backends: [...(runtime.scmBackendsById?.keys() ?? [])],
                hostingProviders: [...runtime.scmHostingProvidersById.keys()],
            });
            const initialScmRegistrations = readScmRegistrations();
            const settingsResponse = await handler({
                machineId: 'test-machine', locale: 'fr-FR', selection: 'settings',
            });
            const settings = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(settingsResponse);
            expect.soft(await handler({ machineId: 'test-machine', locale: 'ja', selection: 'settings',
                reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal', appVersion: '99.0.0' },
            })).toBe(settingsResponse);
            expect(settings.projection).toMatchObject({ installedPackagesById: {}, agentsById: {}, actionsById: {},
                toolsById: {}, commandsById: {}, resourcesById: {}, familiesById: {}, diagnostics: [] });
            expect(settings.automationEligibleEvents).toBeUndefined();
            expect(settings.composerSurfaceCatalog).toBeUndefined();
            expect({ serverFeatureReads, installedPackageReads, executionOriginContextReads }).toEqual({
                serverFeatureReads: 0, installedPackageReads: 0, executionOriginContextReads: 0,
            });
            const initialAdmission = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await handler({
                machineId: 'test-machine', locale: 'fr-FR', selection: 'connectedAccountAdmission',
            }));
            expect(initialAdmission.projection).toMatchObject({ agentsById: {}, toolsById: {}, commandsById: {}, settingsById: {}, diagnostics: [] });
            expect(initialAdmission.automationEligibleEvents).toBeUndefined();
            expect(initialAdmission.composerSurfaceCatalog).toBeUndefined();
            expect(serverFeatureReads).toBe(0);
            expect(installedPackageReads).toBe(1);
            expect(executionOriginContextReads).toBeGreaterThan(0);
            expect(readScmRegistrations()).toEqual(initialScmRegistrations);
            serverFeatureReads = 0;
            installedPackageReads = 0;
            executionOriginContextReads = 0;
            const fullResponse = await handler({
                machineId: 'test-machine', locale: 'fr-FR',
            });
            const full = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(fullResponse);
            const fullAgain = await handler({ machineId: 'test-machine', locale: 'fr-FR' });
            expect.soft(fullAgain).toBe(fullResponse);
            const equivalentHostResponse = await handler({ machineId: 'test-machine', locale: 'fr-FR',
                reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal', appVersion: '99.0.0' },
            });
            expect(equivalentHostResponse).toEqual(fullAgain);
            expect.soft(equivalentHostResponse).toBe(fullAgain);
            const equivalentFullBuildReads = installedPackageReads;
            const equivalentFullResponses = new Set([fullResponse, fullAgain, equivalentHostResponse]).size;
            expect.soft(equivalentFullBuildReads).toBe(1);
            // Full discovery and admission-only reads share the same cold declarations.
            const admissionResponse = await handler({
                machineId: 'test-machine', locale: 'fr-FR', selection: 'connectedAccountAdmission',
            });
            const admission = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(admissionResponse);
            expect.soft(await handler({ machineId: 'test-machine', locale: 'ja', selection: 'connectedAccountAdmission',
                reactNativeHostRuntimeIdentity: { platform: 'android', channel: 'store', appVersion: '99.0.0' },
            })).toBe(admissionResponse);
            const selectedResponse = await handler({ machineId: 'test-machine', selection: 'agents' });
            const selected = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(selectedResponse);
            expect.soft(await handler({ machineId: 'test-machine', selection: 'agents', locale: 'ja' })).toBe(selectedResponse);
            expect(serverFeatureReads).toBeGreaterThan(0);
            expect(installedPackageReads).toBeGreaterThan(0);
            expect(executionOriginContextReads).toBeGreaterThan(0);
            expect(settings.projection.settingsById).toEqual(full.projection.settingsById);
            expect(admission.projection.installedPackagesById).toEqual(full.projection.installedPackagesById);
            expect(admission.projection.actionsById).toEqual(full.projection.actionsById);
            // Purpose setup/readiness consumes declared services and availability.
            let comparedPurposes = 0;
            for (const action of Object.values(initialAdmission.projection.actionsById)) {
                for (const declaration of action.connectedAccountPurposes ?? []) {
                    comparedPurposes += 1;
                    const purpose = { consumer: { pluginId: action.pluginId, localId: action.id }, purpose: declaration.purpose };
                    const read = (projection: typeof admission.projection) => readDeclaredConnectedAccountPurposeV1({
                        purpose, projection, machineProvisionersById: projection.familiesById.machineProvisioners?.entriesById ?? {},
                    });
                    expect(read(initialAdmission.projection)).toEqual(read(admission.projection));
                }
            }
            expect(comparedPurposes).toBeGreaterThan(0);
            expect(admission.projection.resourcesById).toEqual(full.projection.resourcesById);
            expect(admission.projection.familiesById).toEqual({
                connectedAccounts: full.projection.familiesById.connectedAccounts,
                machineProvisioners: full.projection.familiesById.machineProvisioners,
            });
            // A fresh build must agree with the retained descriptive response.
            invalidateDaemonContributionRegistryProjectionCache();
            expect(await handler({ machineId: 'test-machine', locale: 'fr-FR',
                reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal', appVersion: '99.0.0' },
            })).toEqual(fullAgain);
            const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
            const families = Object.fromEntries(Object.entries(full.projection).map(([id, value]) => [id, byteSize(value)]));
            console.info(JSON.stringify({ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                bytes: byteSize(full), agentSelectionBytes: byteSize(selected), equivalentFullBuildReads, equivalentFullResponses, families,
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
            expect(byteSize(settings)).toBeLessThan(byteSize(full));
            expect(byteSize(admission)).toBeLessThan(byteSize(full));
            expect(await handler({ machineId: 'test-machine', locale: 'fr-FR' })).toEqual(full);
            const coldWindows = [];
            for (let repeat = 0; repeat < 5; repeat += 1) {
                invalidateDaemonContributionRegistryProjectionCache();
                const before = installedPackageReads;
                const catalog = blockNextCatalogRead();
                const started = performance.now();
                const concurrent = Array.from({ length: 4 }, () => handler({ machineId: 'test-machine', locale: 'fr-FR' }));
                try {
                    await catalog.entered;
                    await new Promise(resolve => setImmediate(resolve));
                } finally {
                    catalog.release();
                }
                const responses = await Promise.all(concurrent);
                const coldMs = performance.now() - started;
                const coldBuilds = installedPackageReads - before;
                const warmStarted = performance.now();
                const warm = await handler({ machineId: 'test-machine', locale: 'fr-FR' });
                coldWindows.push({ callers: concurrent.length, coldBuilds, warmBuilds: installedPackageReads - before - coldBuilds,
                    responseIdentities: new Set(responses).size, coldMs, warmMs: performance.now() - warmStarted });
                expect(coldBuilds).toBe(1);
                expect(installedPackageReads - before).toBe(1);
                for (const response of responses) expect(response).toBe(warm);
            }
            // The catalog is a filesystem boundary. A slower earlier request
            // must use the authority observed after preparation, not republish
            // the origin retired while it waited. Exercise both selected and
            // full demand, including withdrawal rather than last-known-good.
            expect(Object.values(full.projection.actionsById).some(action => action.executionOrigin)).toBe(true);
            for (const selection of ['connectedAccountAdmission', undefined] as const) {
                for (const currentServerIdentityId of ['srv_origin_current', null]) {
                    invalidateDaemonContributionRegistryProjectionCache();
                    serverIdentityId = 'srv_origin_before';
                    const catalog = blockNextCatalogRead();
                    const request = { machineId: 'test-machine', ...(selection ? { selection } : {}) };
                    const earlier = handler(request);
                    await catalog.entered;
                    serverIdentityId = currentServerIdentityId;
                    let current;
                    try { current = await handler(request); } finally { catalog.release(); }
                    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(current).projection;
                    const origins = Object.values(projection.actionsById).flatMap(action => action.executionOrigin ? [action.executionOrigin] : []);
                    if (currentServerIdentityId === null) expect(origins).toEqual([]);
                    else {
                        expect(origins.length).toBeGreaterThan(0);
                        expect(origins.every(origin => origin.serverIdentityId === currentServerIdentityId)).toBe(true);
                    }
                    expect.soft(await earlier).toBe(current);
                    expect.soft(await handler(request)).toBe(current);
                }
            }
            // Withdrawal and recovery can cross two initial input witnesses.
            // Once both filesystem reads finish, neither build may wait on the
            // other's now-superseded initial witness. No timeout is involved:
            // each event-loop turn drains all runnable preparation microtasks.
            invalidateDaemonContributionRegistryProjectionCache();
            serverIdentityId = 'srv_origin_before';
            const firstCatalog = blockNextCatalogRead();
            let secondCatalog: ReturnType<typeof blockNextCatalogRead> | undefined;
            const request = { machineId: 'test-machine', selection: 'connectedAccountAdmission' };
            const first = handler(request);
            let firstSettled = false;
            void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
            try {
                await firstCatalog.entered;
                serverIdentityId = null;
                secondCatalog = blockNextCatalogRead();
                const second = handler(request);
                let secondSettled = false;
                void second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
                await secondCatalog.entered;
                firstCatalog.release();
                await new Promise(resolve => setImmediate(resolve));
                serverIdentityId = 'srv_origin_before';
                secondCatalog.release();
                await new Promise(resolve => setImmediate(resolve));
                expect(firstSettled).toBe(true);
                expect(secondSettled).toBe(true);
                await Promise.all([first, second]);
            } finally {
                firstCatalog.release();
                secondCatalog?.release();
            }
        } finally {
            clock.mockRestore();
            await runtime.dispose();
            if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
            else process.env.HAPPIER_HOME_DIR = previousHome;
            reloadConfiguration();
            invalidateDaemonContributionRegistryProjectionCache();
        }
    }, 120_000);

    it('returns verified Artifact metadata and detects changed installed files on the next read', async () => {
        const relativePath = 'hosted-web/panel/index.html';
        const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);
        const files = [{ relativePath, bytes }];
        const digest = computePluginUiArtifactFileSetSha256DigestV1(files);
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'panel', tier: 'hostedWeb', entry: relativePath,
            files: [{ relativePath, digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.byteLength }],
            digest, builtWith: { staging: 'staticDirectory' }, hostUiApiRange: '^1.0.0',
        });
        const author = definePlugin({ id: 'cost.plugin', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            ui: { renderers: [{ id: 'panel-renderer', kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'panel' } }] },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: author.manifest,
            files: { 'daemon.mjs': 'export function activate() {}',
                [`${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/ui-artifacts.json`]: JSON.stringify({ version: 2, entries: [graph] }),
                [`${GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH}/${relativePath}`]: Buffer.from(bytes).toString('utf8'),
            } }], coldStart: true });
        const runtime = fixture.registry;
        const generation = fixture.committed.generations.get('cost.plugin');
        if (!generation) throw new Error('Missing admitted Artifact fixture');
        const installedRoot = join(generation.rootPath, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
        try {
            const handlers = new Map<string, RpcHandler>();
            let hostedWebEnabled = true;
            let failCatalogRead = false;
            let catalogReads = 0;
            let catalogGate: Promise<void> | undefined;
            registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } },
                { resolveRuntimeRegistry: async () => runtime, resolveGeneration: async () => 1,
                    processEnv: { HAPPIER_FEATURE_PLUGINS_UI_HOSTED_WEB__ENABLED: '1' },
                    // Home features and the installed-package filesystem are system boundaries.
                    resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
                        features: { plugins: { enabled: true, ui: { enabled: hostedWebEnabled, hostedWeb: { enabled: true } } } },
                    }) }),
                    resolveInstalledPackages: async () => {
                        catalogReads += 1;
                        if (failCatalogRead) { failCatalogRead = false; throw new Error('catalog filesystem unavailable'); }
                        await catalogGate;
                        return [];
                    },
                });
            const describe = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
            const noFrame = await describe({ machineId: 'test-machine' });
            expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(noFrame).projection.familiesById.pluginUi
                ?.entriesById['hostedWeb:cost.plugin:panel-renderer']).toMatchObject({ runtime: {
                    state: 'fallback', decision: { reason: 'hosted_web_frame_adapter_unavailable' },
                } });
            const webRequest = { machineId: 'test-machine', hostedWebFrameCapability: { platform: 'web', adapter: 'domIframe' } };
            const web = await describe(webRequest);
            expect(web).not.toBe(noFrame);
            expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(web).projection.familiesById.pluginUi
                ?.entriesById['hostedWeb:cost.plugin:panel-renderer']).toMatchObject({ runtime: { state: 'available' } });
            expect(await describe({ machineId: 'test-machine', hostedWebFrameCapability: { platform: 'ios', adapter: 'WKWebView' } })).toBe(web);
            invalidateDaemonContributionRegistryProjectionCache();
            expect(await describe({ machineId: 'test-machine', hostedWebFrameCapability: { platform: 'ios', adapter: 'WKWebView' } })).toEqual(web);
            await expect(describe({ machineId: 'test-machine', hostedWebFrameCapability: { platform: 'web', adapter: 'WKWebView' } })).rejects.toThrow();
            hostedWebEnabled = false;
            const disabled = await describe(webRequest);
            expect(disabled).not.toBe(web);
            expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(disabled).projection.familiesById.pluginUi
                ?.entriesById['hostedWeb:cost.plugin:panel-renderer']).toMatchObject({ runtime: {
                    state: 'fallback', decision: { reason: 'feature_disabled' },
                } });
            invalidateDaemonContributionRegistryProjectionCache();
            failCatalogRead = true;
            await expect(describe(webRequest)).rejects.toThrow('catalog filesystem unavailable');
            const readsBeforeConcurrent = catalogReads;
            let releaseCatalog = () => {};
            catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
            const pending = [describe(webRequest), describe(webRequest), describe(webRequest)];
            await new Promise(resolve => setImmediate(resolve));
            releaseCatalog();
            const responses = await Promise.all(pending);
            expect(catalogReads - readsBeforeConcurrent).toBe(1);
            expect(responses[1]).toBe(responses[0]);
            expect(responses[2]).toBe(responses[0]);
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
            // A new request must still catch mutable installed files; no cache
            // or second identity authority is introduced by metadata reuse.
            await writeFile(join(installedRoot, relativePath), new Uint8Array(bytes.length).fill(98));
            expect(await read()).toMatchObject({ ok: false, code: 'artifact_integrity_failed' });
        } finally { invalidateDaemonContributionRegistryProjectionCache(); await fixture.dispose(); }
    });
});
