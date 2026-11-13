import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema, normalizePluginReleaseFactsV1, createPluginAccountBundledSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { DaemonPluginStructuredMessageActionMountedBinding } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { deriveMountedPluginInvocationCaller } from './mountedPluginInvocationCaller';
import { readCurrentAccountPluginExecutionSelection } from '../accountPluginActivationSource';
import type { ResolvedWorkItemsContribution } from '@/plugins/projection/registry/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/plugin-sdk/events';

it('admits current Event setup and typed picker mounts through their declared contributor identities', async () => {
    const pluginId = 'com.acme.embedded';
    const machineId = 'embedded-machine';
    const manifest = createPluginManifestV2Fixture({ id: pluginId, engines: { happier: '>=0.0.0' }, contributes: {
        ui: { renderers: [{ id: 'form', kind: 'declarative', root: { kind: 'text', text: 'Configure' } }],
            views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'form' }] },
        actions: [{ id: 'setup', title: 'Setup', execution: { target: 'daemon' }, scopes: ['global'],
            surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: { type: 'object' },
            resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, { type: 'object' }) }],
        events: ['configured', 'headless'].map(id => ({ id, kind: 'event', title: id,
            payloadSchema: { type: 'object' }, automation: { v: 1, eligible: true, source: {
                sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                sourceConfigSchema: { type: 'object' }, setupActionRef: { pluginId, localId: 'setup' },
                ...(id === 'configured' ? { setupSurface: { renderer: 'form' } } : {}),
            } } })),
        inputTypes: [{ id: 'destination', title: 'Destination', semantic: 'destination', valueSchema: { type: 'string' }, picker: 'form' },
            { id: 'plain-value', title: 'Plain value', semantic: 'plain', valueSchema: { type: 'string' } }],
    } });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest,
        files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("setup", async () => ({})); }' } }],
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
        runtimeOptions: { resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_embedded', machineId }) },
    });
    try {
        const { registry } = fixture;
        const occurrenceId = registry.readPluginOccurrenceId?.(pluginId);
        const sourceCustody = registry.readPluginSourceCustody?.(pluginId);
        if (!occurrenceId || !sourceCustody) throw new Error('Expected admitted embedded source');
        expect(registry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
        expect(registry.isPluginOccurrenceCurrent?.(pluginId, occurrenceId)).toBe(true);
        const materializationRef = registry.resolveCurrentPluginMaterializationRef?.(pluginId);
        const binding = { pluginId, occurrenceId, sourceCustody, contributionLocalId: 'configured',
            ...(materializationRef ? { materializationRef } : {}) };
        const derive = (contributionLocalId: string, overrides: Partial<DaemonPluginStructuredMessageActionMountedBinding> = {}) =>
            deriveMountedPluginInvocationCaller({ request: { machineId, invocationSurface: 'ui', invocation: {
                kind: 'mountedPluginSurface', mountedBinding: { ...binding, contributionLocalId, ...overrides },
            } }, registry, resolveCurrentPluginMaterializationRef: registry.resolveCurrentPluginMaterializationRef,
            resolveExecutionOriginContext: () => ({ serverIdentityId: 'srv_embedded', machineId }) });
        expect((await derive('page')).status).toBe('available');
        for (const contributionLocalId of ['configured', 'destination']) {
            const caller = await derive(contributionLocalId);
            expect(caller.status, contributionLocalId).toBe('available');
            if (caller.status !== 'available') throw new Error('Expected declared embedded caller');
            expect(caller.caller.contribution).toEqual({ id: contributionLocalId, qualifiedId: `${pluginId}/${contributionLocalId}` });
            expect(await caller.isMountedCallerCurrent()).toBe(true);
            expect(await derive(contributionLocalId, { occurrenceId: 'retired' })).toEqual({ status: 'unavailable' });
            expect(await derive(contributionLocalId, { pluginId: 'other.plugin' })).toEqual({ status: 'unavailable' });
            expect(await derive(contributionLocalId, { materializationRef: { pluginId, machineId: 'other-machine', materializationId: 'foreign' } }))
                .toEqual({ status: 'unavailable' });
        }
        for (const contributionLocalId of ['headless', 'plain-value', 'form', 'forged'])
            expect(await derive(contributionLocalId), contributionLocalId).toEqual({ status: 'unavailable' });
    } finally { await fixture.dispose(); }
});

describe('Account nested Action caller provenance', () => {
    it('uses current Account declaration custody without a Machine occurrence and retires changed or disabled callers', async () => {
        const pluginId = 'com.acme.portable';
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, entrypoints: {}, contributes: {
            ui: { renderers: [{ id: 'panel', kind: 'declarative', root: { kind: 'text', text: 'Portable page' } }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'panel' }] },
            targetedPluginContributions: [{ id: 'source', target: { pluginId: 'com.acme.detail-host', pointId: 'details' },
                protocol: { id: 'detail', version: 1 }, operations: {}, surfaces: { detail: { renderer: 'panel' } } }],
            actions: [{ id: 'aggregate', title: 'Aggregate', scopes: ['global'], surfaces: ['cli'], dangerLevel: 'safe',
                placementBindings: [], execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } }],
        } }));
        let enabled = true;
        let bundled = false;
        let currentManifest = manifest;
        let receivingMachineId = 'reading-machine';
        let archiveDigestSha256 = `sha256:${'a'.repeat(64)}`;
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
            PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: { pluginId, desiredVersion: bundled ? null : manifest.version, enabled, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: bundled ? null : normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version }, archiveDigestSha256,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } }), uiArtifacts: [], packageAssets: [] }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://account-provenance.test' });
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [], contributes: createResolvedContributionRegistry({}),
        } })
            .catch(async error => { restore(); await app.close(); throw error; });
        try {
            const binding = { pluginId, contributionLocalId: 'aggregate', occurrenceId: 'invoking-process-only',
                sourceCustody: { kind: 'account_release' as const, pluginId, version: manifest.version, archiveDigestSha256 } };
            const registry = fixture.registry;
            const resolveAccountExecutionSelection = async (currentPluginId: string) => readCurrentAccountPluginExecutionSelection({ pluginId: currentPluginId,
                serverUrl: 'http://account-provenance.test', credentials: { token: 'fixture', encryption: null },
                bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/portable', manifest: currentManifest }),
            });
            const resolveExecutionOriginContext = async () => ({ serverIdentityId: 'srv_account-provenance', machineId: receivingMachineId });
            const derive = (contributionLocalId = 'aggregate', callerBinding: DaemonPluginStructuredMessageActionMountedBinding = binding,
                targetMachineId = 'reading-machine') => deriveMountedPluginInvocationCaller({
                request: { machineId: targetMachineId, invocationSurface: 'cli',
                    invocation: { kind: 'clientPluginAction', clientActionBinding: { ...callerBinding, contributionLocalId } } },
                registry,
                resolveAccountExecutionSelection,
                resolveExecutionOriginContext,
            });
            expect((await resolveAccountExecutionSelection(pluginId)).kind).toBe('available');
            const caller = await derive();
            expect(caller.status).toBe('available');
            if (caller.status !== 'available') throw new Error('Expected Account caller');
            expect(caller.caller).toEqual({ kind: 'plugin', pluginId,
                contribution: { id: 'aggregate', qualifiedId: `${pluginId}/aggregate` }, occurrenceId: binding.occurrenceId,
                sourceCustody: binding.sourceCustody, originSurface: 'cli' });
            expect(await caller.isMountedCallerCurrent()).toBe(true);
            const deriveSurface = (callerBinding: DaemonPluginStructuredMessageActionMountedBinding, contributionLocalId = 'page') => deriveMountedPluginInvocationCaller({
                request: { machineId: 'reading-machine', invocationSurface: 'ui', invocation: {
                    kind: 'mountedPluginSurface', mountedBinding: { ...callerBinding, contributionLocalId },
                } }, registry, resolveAccountExecutionSelection, resolveExecutionOriginContext,
            });
            const pageCaller = await deriveSurface(binding);
            expect(pageCaller.status).toBe('available');
            if (pageCaller.status !== 'available') throw new Error('Expected portable Account page caller');
            expect(pageCaller.caller).toMatchObject({ occurrenceId: binding.occurrenceId, sourceCustody: binding.sourceCustody,
                contribution: { id: 'page', qualifiedId: `${pluginId}/page` }, originSurface: 'ui' });
            expect(pageCaller.caller).not.toHaveProperty('executionOrigin');
            expect(await pageCaller.isMountedCallerCurrent()).toBe(true);
            expect((await deriveSurface(binding, 'source')).status).toBe('available');
            expect(await deriveSurface(binding, 'undeclared-source')).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', binding, 'different-machine')).toEqual({ status: 'unavailable' });
            receivingMachineId = 'replacement-machine';
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            receivingMachineId = 'reading-machine';
            expect(await derive('not-declared')).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...binding, materializationRef: {
                pluginId, machineId: 'reading-machine', materializationId: 'fabricated-machine-custody',
            } })).toEqual({ status: 'unavailable' });
            expect(await deriveMountedPluginInvocationCaller({ request: { machineId: 'reading-machine', invocationSurface: 'ui',
                invocation: { kind: 'mountedPluginSurface', mountedBinding: binding } }, registry, resolveAccountExecutionSelection,
                resolveExecutionOriginContext,
            })).toEqual({ status: 'unavailable' });
            archiveDigestSha256 = `sha256:${'b'.repeat(64)}`;
            expect(await pageCaller.isMountedCallerCurrent()).toBe(false);
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            expect(await derive()).toEqual({ status: 'unavailable' });
            enabled = true;
            bundled = true;
            const bundledBinding: DaemonPluginStructuredMessageActionMountedBinding = { ...binding, pluginVersion: manifest.version,
                sourceCustody: createPluginAccountBundledSelectionV1({ packageName: '@acme/portable', manifest }).sourceCustody };
            const bundledCaller = await derive('aggregate', bundledBinding);
            expect((await deriveSurface(bundledBinding)).status).toBe('available');
            expect((await deriveSurface(bundledBinding, 'source')).status).toBe('available');
            expect(bundledCaller.status).toBe('available');
            if (bundledCaller.status !== 'available') throw new Error('Expected bundled Account caller');
            expect(bundledCaller.caller).not.toHaveProperty('materialization');
            expect(bundledCaller.caller).not.toHaveProperty('executionOrigin');
            expect(await derive('aggregate', { ...bundledBinding, pluginVersion: '2.0.0' })).toEqual({ status: 'unavailable' });
            expect(await derive('aggregate', { ...bundledBinding, pluginVersion: undefined })).toEqual({ status: 'unavailable' });
            currentManifest = normalizePluginManifestV2({ ...manifest, contributes: { ...manifest.contributes,
                actions: manifest.contributes.actions.map(action => ({ ...action, dangerLevel: 'writesRemote',
                    confirmation: { title: 'Confirm changed declaration' } })),
            } });
            expect(await bundledCaller.isMountedCallerCurrent()).toBe(true);
            currentManifest = normalizePluginManifestV2({ ...manifest, version: '2.0.0' });
            expect(await bundledCaller.isMountedCallerCurrent()).toBe(false);
            archiveDigestSha256 = binding.sourceCustody.archiveDigestSha256;
            enabled = false;
            expect(await caller.isMountedCallerCurrent()).toBe(false);
            expect(await derive()).toEqual({ status: 'unavailable' });
        } finally { await fixture.dispose(); restore(); await app.close(); }
    });

    it('admits a declared Work Items client registration as a nested caller and refuses foreign or forged callers', async () => {
        const pluginId = 'com.acme.board';
        const workItems = { id: 'work-items', client: { artifactId: 'board-runtime', exportName: 'activate' }, platforms: ['web'] } satisfies ResolvedWorkItemsContribution['definition'];
        const manifest = normalizePluginManifestV2(createPluginManifestV2Fixture({ id: pluginId, entrypoints: {}, contributes: { workItems: [workItems] } }));
        const archiveDigestSha256 = `sha256:${'c'.repeat(64)}`;
        const app = fastify();
        app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
            PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: { pluginId, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
                release: normalizePluginReleaseFactsV1({ ref: { pluginId, version: manifest.version }, archiveDigestSha256,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
                    packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } }), uiArtifacts: [], packageAssets: [] }));
        await app.ready();
        const restore = installAxiosFastifyAdapter({ app, origin: 'http://work-items-caller.test' });
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            pluginIds: [], contributes: createResolvedContributionRegistry({}),
        } })
            .catch(async error => { restore(); await app.close(); throw error; });
        try {
            const resolveExecutionOriginContext = async () => ({ serverIdentityId: 'srv_work-items', machineId: 'reading-machine' });
            const resolveAccountExecutionSelection = async (currentPluginId: string) => readCurrentAccountPluginExecutionSelection({
                pluginId: currentPluginId, serverUrl: 'http://work-items-caller.test', credentials: { token: 'fixture', encryption: null },
            });
            // Account-selected Board registration (the app's own Work Items callback).
            const accountBinding: DaemonPluginStructuredMessageActionMountedBinding = { pluginId, contributionLocalId: 'work-items',
                occurrenceId: 'board-process', sourceCustody: { kind: 'account_release', pluginId, version: manifest.version, archiveDigestSha256 } };
            const deriveAccount = (callerBinding: DaemonPluginStructuredMessageActionMountedBinding) => deriveMountedPluginInvocationCaller({
                request: { machineId: 'reading-machine', invocationSurface: 'ui',
                    invocation: { kind: 'clientPluginAction', clientActionBinding: callerBinding } },
                registry: fixture.registry, resolveAccountExecutionSelection, resolveExecutionOriginContext,
            });
            const accountCaller = await deriveAccount(accountBinding);
            expect(accountCaller.status).toBe('available');
            if (accountCaller.status !== 'available') throw new Error('Expected Account Work Items caller');
            expect(accountCaller.caller).toMatchObject({ pluginId, contribution: { id: 'work-items', qualifiedId: `${pluginId}/work-items` },
                occurrenceId: 'board-process', sourceCustody: accountBinding.sourceCustody });
            expect(await accountCaller.isMountedCallerCurrent()).toBe(true);
            expect(await deriveAccount({ ...accountBinding, contributionLocalId: 'forged' })).toEqual({ status: 'unavailable' });
            expect(await deriveAccount({ ...accountBinding, pluginId: 'other.plugin',
                sourceCustody: { kind: 'account_release', pluginId: 'other.plugin', version: manifest.version, archiveDigestSha256 } }))
                .toEqual({ status: 'unavailable' });
            expect(await deriveAccount({ ...accountBinding, sourceCustody: { kind: 'account_release', pluginId, version: manifest.version,
                archiveDigestSha256: `sha256:${'e'.repeat(64)}` } })).toEqual({ status: 'unavailable' });

            // Machine-admitted occurrence of the same registration.
            const sourceCustody = createPluginAccountBundledSelectionV1({ packageName: '@acme/board', manifest }).sourceCustody;
            const declaration: ResolvedWorkItemsContribution = { provenance: 'first_party', source: { kind: 'bundled' }, pluginId,
                identity: { pluginId, localId: 'work-items' }, manifestPath: 'bundled:board', definition: workItems, pluginRootPath: '/board' };
            let occurrenceCurrent = true;
            const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
            const registry = { contributes: createResolvedContributionRegistry({ workItems: [declaration] }),
                readPluginOccurrenceId: () => occurrenceId, readPluginSourceCustody: () => sourceCustody,
                isPluginOccurrenceCurrent: () => occurrenceCurrent };
            const machineBinding: DaemonPluginStructuredMessageActionMountedBinding = { pluginId, contributionLocalId: 'work-items',
                occurrenceId, sourceCustody };
            const deriveMachine = (callerBinding: DaemonPluginStructuredMessageActionMountedBinding, machineId = 'reading-machine') =>
                deriveMountedPluginInvocationCaller({ request: { machineId, invocationSurface: 'ui',
                    invocation: { kind: 'clientPluginAction', clientActionBinding: callerBinding } }, registry, resolveExecutionOriginContext });
            const machineCaller = await deriveMachine(machineBinding);
            expect(machineCaller.status).toBe('available');
            if (machineCaller.status !== 'available') throw new Error('Expected Machine Work Items caller');
            expect(machineCaller.caller).toMatchObject({ contribution: { id: 'work-items' }, occurrenceId });
            expect(await deriveMachine({ ...machineBinding, contributionLocalId: 'forged' })).toEqual({ status: 'unavailable' });
            expect(await deriveMachine({ ...machineBinding, occurrenceId: 'stale-occurrence' })).toEqual({ status: 'unavailable' });
            expect(await deriveMachine(machineBinding, 'other-machine')).toEqual({ status: 'unavailable' });
            occurrenceCurrent = false;
            expect(await machineCaller.isMountedCallerCurrent()).toBe(false);
        } finally { await fixture.dispose(); restore(); await app.close(); }
    });
});
