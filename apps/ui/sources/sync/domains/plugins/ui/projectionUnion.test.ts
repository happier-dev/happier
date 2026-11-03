import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor, PluginProjectionV2Schema, PluginProjectedResourceV2Schema, RPC_METHODS } from '@happier-dev/protocol';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import * as originEquality from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { PluginDeclarativeProjectedModelV1Schema } from '@happier-dev/protocol/plugins/contributions/ui/declarativeProjectedModelV1';
import {
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiSettingsPageBindingV1,
    type PluginUiDestinationBindingInputV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginReleaseFactsV1Schema, PluginMachineMaterializationV1Schema, PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/v1';
import { projectPluginPortableUiDeclarationsV1, projectPluginReactNativeArtifactEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginClientApi } from '@happier-dev/plugin-sdk';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { dispatchPluginSurfaceAction } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginUiProjectedActionResolver } from './projection';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit';
import { createPluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { resolvePluginMachineExecutionOriginState } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolvePluginSurfaceDestinationOpen } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';

import { normalizePluginUiProjection, EMPTY_PLUGIN_UI_PROJECTION } from './projection';
import * as projectionUnion from './projectionUnion';
import { selectPluginSurfacePlacementsForBinding } from './surfacePlacementSelectors';
import { readPluginUiDaemonProjectionSelection } from './artifactAdoption';
import { resolveAdmittedPluginSettingsPage } from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';
import { resolvePluginAppPages, selectPluginAppPagePlacements } from '@/components/appShell/plugins/pluginAppPages';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import {
    arePluginUiProjectionUnionMembersEquivalent,
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
    unionPluginUiProjections,
    mergeInstalledPluginUiProjections,
    readPluginUiContributionSupplies,
    readPluginUiExecutionOriginCandidates,
    PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY,
    type PluginUiProjectionUnionMember,
} from './projectionUnion';

// The daemon RPC is the system boundary. Schema admission and dispatch below
// consume the real transport decoder rather than mocking an internal resolver.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: Readonly<{ method: string }>) => {
        if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) throw new Error('Unexpected daemon RPC');
        return { ok: true, inputSchema: { type: 'string' } };
    },
}));

it('retains proven installed declarations on a cold client without fabricating runtime identity', () => {
    const entry = { ...placementEntry({ pluginId: 'acme.channels', localId: 'channels', container: 'appPage' }), occurrenceId: undefined };
    const installed = { ...machineProjection({ generation: 1, entriesById: { [String(entry.id)]: entry } }), generation: null };
    const merged = mergeInstalledPluginUiProjections([installed], null);
    expect(merged?.surfacePlacementsById[String(entry.id)]).toMatchObject({ pluginId: 'acme.channels' });
    expect(merged?.surfacePlacementsById[String(entry.id)]?.occurrenceId).toBeUndefined();
    expect(merged?.generation).toBeNull();
    expect(mergeInstalledPluginUiProjections([], null)).toBeNull();
});

it('retains current Account authentication descriptors through AppShell composition and withdraws retired selections', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'happier.fixture', version: '1.0.0',
        displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: { connectedAccountDescriptors: [{
            id: 'subscription', title: 'Subscription', authentication: {
                account: { artifactId: 'authentication', exportName: 'authenticate' },
                defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', outcomeReconciliation: 'none' }],
            },
        }] } });
    const definition = manifest.contributes.connectedAccountDescriptors![0]!;
    const key = `${manifest.id}/${definition.id}`;
    const descriptor = { id: definition.id, pluginId: manifest.id, occurrenceId: 'account-selection', definition,
        hostAccountOrigin: { serverId: 'home', accountId: 'account', custodyId: 'account-selection',
            sourceCustody: { kind: 'bundled_first_party' as const,
                packagedRuntime: { kind: 'source_declaration' as const, packageName: '@happier-dev/plugins-fixture' } } } };
    const account = { ...EMPTY_PLUGIN_UI_PROJECTION, connectedAccountDescriptorsById: { [key]: descriptor } };
    const publication = projectionUnion.createInstalledPluginUiProjectionPublication();
    const first = publication.publish([account], EMPTY_PLUGIN_UI_PROJECTION);
    expect(first?.connectedAccountDescriptorsById?.[key]).toBe(descriptor);
    expect(publication.publish([account], EMPTY_PLUGIN_UI_PROJECTION)?.connectedAccountDescriptorsById)
        .toBe(first?.connectedAccountDescriptorsById);
    const changed = { ...descriptor, definition: { ...definition, title: 'Updated subscription' } };
    expect(publication.publish([{ ...account, connectedAccountDescriptorsById: { [key]: changed } }], EMPTY_PLUGIN_UI_PROJECTION)
        ?.connectedAccountDescriptorsById?.[key]).toBe(changed);
    expect(publication.publish([], EMPTY_PLUGIN_UI_PROJECTION)?.connectedAccountDescriptorsById?.[key]).toBeUndefined();
});

it('retains current Account Actions through installed composition without replacing Machine Actions', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'account', tier: 'reactNative', digest,
        entry: 'react-native/account/entry.cjs.bundle',
        files: [{ relativePath: 'react-native/account/entry.cjs.bundle', digest, byteSize: 1 }],
        executable: { exports: ['activate'] }, builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0' });
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'happier.fixture', version: '1.0.0',
        displayName: 'Fixture', runtime: { apiVersion: 1 }, contributes: { actions: [{ id: 'read', title: 'Read',
            scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account', exportName: 'activate' } } }],
            ui: { renderers: [{ id: 'page', kind: 'declarative', root: { kind: 'text', text: 'Account page' } }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'Account page', renderer: 'page' }] } } });
    const reader = createPluginAccountAvailabilityReader({ scope: { serverId: 'server-1', accountId: 'account-1' },
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [{ pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
            packageName: '@happier-dev/plugins-fixture', normalizedManifest: manifest, artifactGraphs: [graph],
            entriesById: projectPluginPortableUiDeclarationsV1(manifest) }],
    });
    const installed = reader.readAccountUiProjection()!;
    const action = installed.actionsById['happier.fixture/read']!;
    expect(action).toBeDefined();
    const runtimeAction = { ...action, id: 'machine-read', execution: { target: 'daemon' as const } };
    const runtime = { ...EMPTY_PLUGIN_UI_PROJECTION, actionsById: {
        'happier.fixture/read': { ...runtimeAction, id: 'read' }, 'happier.fixture/machine-read': runtimeAction,
    } };
    expect(mergeInstalledPluginUiProjections([installed], null)?.actionsById['happier.fixture/read']).toBe(action);
    expect(mergeInstalledPluginUiProjections([installed], runtime)?.actionsById).toEqual({
        'happier.fixture/read': action, 'happier.fixture/machine-read': runtimeAction,
    });
    expect(mergeInstalledPluginUiProjections([], runtime)?.actionsById).toEqual(runtime.actionsById);
    const bundleId = 'reactNativeBundle:happier.fixture:read';
    const accountBundle = installed.reactNativeBundlesById[bundleId]!;
    expect(resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: installed }, platform: 'web' }))
        .toMatchObject([{ authority: { kind: 'account', custodyId: action.occurrenceId }, actions: [{ id: 'read' }] }]);
    const machineOrigin = { machineId: 'machine-optional', serverId: 'server-1',
        phase: 'current' as const, interactionEnabled: true, executionOrigin: null };
    // Distinct Actions may use the same physical artifact/export in both realms.
    const clientAction = { ...action, id: 'machine-client', hostAccountOrigin: undefined, occurrenceId: 'machine:current',
        execution: { target: 'client' as const, client: { artifactId: 'account', exportName: 'activate' }, platforms: ['web' as const] },
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: machineOrigin };
    const clientBundleId = 'reactNativeBundle:happier.fixture:machine-client';
    const runtimeWithExecutableGraph = { ...runtime, actionsById: { ...runtime.actionsById, 'happier.fixture/machine-client': clientAction },
        reactNativeBundlesById: { [bundleId]: {
        ...accountBundle, hostAccountOrigin: undefined, occurrenceId: 'machine:current',
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: machineOrigin,
    }, [clientBundleId]: { ...accountBundle, id: clientBundleId, contributionId: 'machine-client', hostAccountOrigin: undefined,
        occurrenceId: 'machine:current', [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: machineOrigin } } };
    const executableProjection = mergeInstalledPluginUiProjections([installed], runtimeWithExecutableGraph)!;
    const composedAction = executableProjection.actionsById['happier.fixture/read']!;
    const selected = reader.readCurrentAccountExecution(manifest.id);
    if (selected.kind !== 'available') throw new Error('Missing selected bundled declaration');
    expect(composedAction.accountActionDeclaration).toBe(selected.manifest.contributes.actions[0]);
    const executables = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: executableProjection }, platform: 'web' });
    expect(executables).toHaveLength(2);
    expect(executables).toEqual(expect.arrayContaining([
        expect.objectContaining({ authority: { kind: 'account', serverId: 'server-1', accountId: 'account-1', custodyId: action.occurrenceId },
            actions: [action], target: { realm: 'account', artifactId: 'account', exportName: 'activate', platform: 'web' } }),
        expect.objectContaining({ authority: { machineId: 'machine-optional', serverId: 'server-1' }, actions: [clientAction],
            target: { artifactId: 'account', exportName: 'activate', platform: 'web' } }),
    ]));
    const origin = selectedOrigin(manifest.id, 'machine-optional');
    const entry = placementEntry({ pluginId: manifest.id, localId: 'page', container: 'appPage' });
    const runtimeWithSupplier = unionPluginUiProjections([member({ machineId: 'machine-optional', generation: 1,
        entriesById: { [String(entry.id)]: { ...entry, executionOrigin: origin } },
        producerOriginsByPluginId: { [manifest.id]: origin },
    })], selectedOrigins(origin)).pluginUiProjection;
    const pageId = `surfacePlacement:${manifest.id}:page`;
    const composedPage = mergeInstalledPluginUiProjections([installed], runtimeWithSupplier)?.surfacePlacementsById[pageId];
    expect(composedPage).toMatchObject({ occurrenceId: action.occurrenceId, hostAccountOrigin: action.hostAccountOrigin });
    expect(readPluginUiContributionSupplies(composedPage)).toMatchObject([{ machineId: 'machine-optional', executionOrigin: origin }]);
    const withoutPage = PluginPortableReleaseManifestV1Schema.parse({ ...manifest, contributes: {
        ...manifest.contributes, ui: { ...manifest.contributes.ui, views: [] },
    } });
    const retiredPage = createPluginAccountAvailabilityReader({ scope: { serverId: 'server-1', accountId: 'account-1' },
        snapshot: { availabilityCursor: 2, intentReads: [], materializations: [], snapshots: [] },
        hostBundledUi: [{ pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
            packageName: '@happier-dev/plugins-fixture', normalizedManifest: withoutPage, artifactGraphs: [graph],
            entriesById: projectPluginPortableUiDeclarationsV1(withoutPage) }],
    }).readAccountUiProjection()!;
    expect(mergeInstalledPluginUiProjections([retiredPage], runtimeWithSupplier)?.surfacePlacementsById[pageId]).toBeUndefined();
});

it('retains an external archive renderer only from its exact reported installation and artifact slot', () => {
    const mergeInstalledPluginUiProjections = projectionUnion.createInstalledPluginUiProjectionPublication().publish;
    const publishUnion = projectionUnion.createPluginUiProjectionUnionPublication().publish;
    const pluginId = 'com.acme.external';
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
        artifactId: 'main', tier: 'reactNative', digest,
        entry: 'react-native/main/entry.cjs.bundle',
        files: [{ relativePath: 'react-native/main/entry.cjs.bundle', digest, byteSize: 1 }],
        executable: { exports: ['renderSurface'] },
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0',
    });
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'External', runtime: { apiVersion: 1 },
            contributes: { ui: {
                renderers: [{ id: 'main', kind: 'reactNative', artifact: 'main', requiredHostMethods: [] }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'External', renderer: 'main' }],
                translations: [{ locale: 'en', messages: { title: 'External' } }],
            } },
        },
        collectionContracts: [],
        uiSlots: [{ contributionId: 'main', artifactId: 'main', tier: 'reactNative', platform: 'web',
            artifactDigest: digest, hostUiApiRange: '^1.0.0' }],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] },
    });
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: 'srv_test', machineId: 'machine-external', materializationId: 'archive-install',
        pluginId, version: '1.0.0', sourceClass: 'versionedArchive', portableRelease: true,
        archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: release.uiSlots,
        enabled: true, trustState: 'trusted', observedAt: 1,
    });
    const intentRead = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: { pluginId, desiredVersion: release.ref.version, enabled: true, offlineUiHosting: 'disabled',
            writableCollections: [], revision: 'selected-release' },
        release, packageAssets: [], uiArtifacts: [],
    });
    const availability = {
        scope: { serverId: 'server-1', accountId: 'account-1' },
        snapshot: { availabilityCursor: 1, intentReads: [], releases: [release], materializations: [materialization],
            snapshots: [{ serverIdentityId: 'srv_test', machineId: 'machine-external', materializations: [materialization] }] },
    };
    const reader = createPluginAccountAvailabilityReader(availability);
    const installed = reader.readInstalledPlugins();
    if (installed.kind !== 'available') throw new Error('Expected external archive census');
    const models = installed.plugins[0]!.installations.map(installation => installation.uiModel);
    const declarations = projectPluginPortableUiDeclarationsV1(release.normalizedManifest);
    const origin = { serverIdentityId: 'srv_test', materializationRef: {
        machineId: materialization.machineId, materializationId: materialization.materializationId, pluginId,
    } };
    const bundle = { ...projectPluginReactNativeArtifactEntryV1({
        pluginId, pluginVersion: '1.0.0', contributionId: 'main', artifactId: 'main', artifact: graph,
        artifactSelectionOwner: 'accountRelease', generatedOwnerKind: 'renderer', requiredHostMethods: [],
        runtime: { state: 'loadable', diagnostics: [], decision: { state: 'load', reason: 'compatible', diagnostics: [] },
            cacheKey: digest, cacheIdentity: { artifactDigest: digest }, loadPolicy: { source: 'installedArtifact' } },
    }), occurrenceId: 'external:1', executionOrigin: origin };
    const runtimeFor = (entry: typeof bundle) => {
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {},
         resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
            ...Object.fromEntries(Object.entries(declarations).map(([id, declaration]) => [id, {
                ...declaration, occurrenceId: 'external:1', executionOrigin: origin,
            }])), [entry.id]: entry,
        } } },
        }));
        return publishUnion([{ machineId: materialization.machineId, serverId: 'server-1', serverIdentityId: 'srv_test',
            phase: 'current', interactionEnabled: true, projection }], new Map([[pluginId, origin]])).pluginUiProjection!;
    };
    const runtime = runtimeFor(bundle);
    const reports = { [pluginId]: materialization };
    const merged = mergeInstalledPluginUiProjections(models, runtime, reports);
    expect(merged?.reactNativeBundlesById[bundle.id]).toEqual(runtime.reactNativeBundlesById[bundle.id]);
    const accountProjection = createPluginAccountAvailabilityReader({ ...availability,
        snapshot: { ...availability.snapshot, intentReads: [{ pluginId, response: intentRead }] },
    }).readAccountUiProjection()!;
    // App shell composes Account custody after the exact Machine installation
    // and renderer slot have already been admitted; no reports reach this layer.
    const finalProjection = projectionUnion.mergeInstalledPluginUiProjections([accountProjection], merged);
    const pageId = `surfacePlacement:${pluginId}:page`;
    expect(finalProjection?.surfacePlacementsById[pageId]).toBe(merged?.surfacePlacementsById[pageId]);
    expect(finalProjection?.reactNativeBundlesById[bundle.id]).toBe(merged?.reactNativeBundlesById[bundle.id]);
    expect(finalProjection?.reactNativeBundlesById[bundle.id]).toMatchObject({ executionOrigin: origin });
    expect(merged?.translationsByPluginId[pluginId]).toBeDefined();
    expect(finalProjection?.translationsByPluginId[pluginId]).toBe(merged?.translationsByPluginId[pluginId]);
    // Composing descriptive graph facts grants neither Account selection nor bytes.
    expect(reader.readCurrentArtifact({ pluginId, contributionId: 'main', tier: 'reactNative', platform: 'web' }).kind)
        .toBe('unavailable');
    for (const invalid of [
        { ...bundle, pluginVersion: '2.0.0' },
        { ...bundle, executionOrigin: { ...origin, materializationRef: { ...origin.materializationRef, materializationId: 'replaced' } } },
        { ...bundle, artifactGraph: { ...graph, digest: `sha256:${'d'.repeat(64)}` } },
    ]) {
        const rejected = mergeInstalledPluginUiProjections(models, runtimeFor(invalid), reports);
        expect(rejected?.reactNativeBundlesById[bundle.id]).toBeUndefined();
        expect(projectionUnion.mergeInstalledPluginUiProjections([accountProjection], rejected)?.reactNativeBundlesById[bundle.id])
            .toBeUndefined();
    }
    expect(mergeInstalledPluginUiProjections(models, runtime)?.reactNativeBundlesById[bundle.id]).toBeUndefined();
    const otherPlatform = { [pluginId]: { ...materialization,
        uiArtifacts: materialization.uiArtifacts.map(slot => ({ ...slot, platform: 'android' as const })),
    } };
    expect(mergeInstalledPluginUiProjections(models, runtime, otherPlatform)?.reactNativeBundlesById[bundle.id])
        .toBeUndefined();
    const rendererOnlyRelease = PluginReleaseFactsV1Schema.parse({ ...release, normalizedManifest: {
        ...release.normalizedManifest, contributes: { ...release.normalizedManifest.contributes,
            ui: { ...release.normalizedManifest.contributes.ui, views: [], translations: [] } },
    } });
    const rendererOnlyInstalled = createPluginAccountAvailabilityReader({ ...availability,
        snapshot: { ...availability.snapshot, releases: [rendererOnlyRelease] },
    }).readInstalledPlugins();
    if (rendererOnlyInstalled.kind !== 'available') throw new Error('Expected renderer-only installation');
    const rendererOnlyModels = rendererOnlyInstalled.plugins[0]!.installations.map(installation => installation.uiModel);
    expect(mergeInstalledPluginUiProjections(rendererOnlyModels, runtime)?.reactNativeBundlesById[bundle.id]).toBeUndefined();
    const rendererOnlyMerged = mergeInstalledPluginUiProjections(rendererOnlyModels, runtime, reports);
    expect(rendererOnlyMerged?.reactNativeBundlesById[bundle.id]).toEqual(runtime.reactNativeBundlesById[bundle.id]);
    expect(rendererOnlyMerged?.surfacePlacementsById[pageId]).toBeUndefined();
});

it('uses a development override only for the explicitly selected source and otherwise retains the host bundle', () => {
    const mergeInstalledPluginUiProjections = projectionUnion.createInstalledPluginUiProjectionPublication().publish;
    const unionPluginUiProjections = projectionUnion.createPluginUiProjectionUnionPublication().publish;
    const pluginId = 'happier.fixture';
    const entry = placementEntry({ pluginId, localId: 'page', container: 'appPage' });
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
        machineId: 'machine-dev', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
    } });
    const declaredEntry = { ...entry, occurrenceId: undefined, hostSupplies: [], display: { title: 'Bundled page' } };
    const declared = { ...machineProjection({ generation: 1, entriesById: { page: declaredEntry }, installedPackagesById: {
        [pluginId]: { id: pluginId, displayName: 'Fixture', version: '1.0.0', enabled: true, source: { kind: 'bundled' } },
    } }), generation: null };
    const makeRuntime = (online: boolean) => unionPluginUiProjections([member({ machineId: 'machine-dev', generation: 2,
        producerOriginsByPluginId: { [pluginId]: origin },
        interactionEnabled: online, entriesById: { page: { ...entry, executionOrigin: origin, display: { title: 'Edited page' } } }, installedPackagesById: {
            [pluginId]: { id: pluginId, displayName: 'Fixture', version: '1.0.0', enabled: true, source: { kind: 'localPath' },
                occurrenceId: entry.occurrenceId, executionOrigin: origin,
                sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
        } })]).pluginUiProjection;
    const current = makeRuntime(true);
    const installed = [declared];
    // Neither a sole live supplier nor an unavailable remembered target selects its source.
    expect(mergeInstalledPluginUiProjections(installed, current)?.surfacePlacementsById[String(entry.id)]?.display)
        .toEqual({ title: 'Bundled page' });
    const selectedSources = new Map([[pluginId, origin]]);
    const explicitlySelected = mergeInstalledPluginUiProjections(installed, current, undefined, selectedSources);
    expect(explicitlySelected?.surfacePlacementsById[String(entry.id)]?.display)
        .toEqual({ title: 'Edited page' });
    const automaticAgain = mergeInstalledPluginUiProjections(installed, current, undefined, new Map());
    expect(automaticAgain?.surfacePlacementsById[String(entry.id)]?.display).toEqual({ title: 'Bundled page' });
    // A prior merge result is not a fresh explicit decision when reused as an
    // upstream runtime projection.
    expect(mergeInstalledPluginUiProjections(installed, explicitlySelected)?.surfacePlacementsById[String(entry.id)]?.display)
        .toEqual({ title: 'Bundled page' });
    const missingSource = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
        machineId: 'missing-machine', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'another-root' },
    } });
    expect(mergeInstalledPluginUiProjections(installed, current, undefined, new Map([[pluginId, missingSource]]))
        ?.surfacePlacementsById[String(entry.id)]?.display).toEqual({ title: 'Bundled page' });
    const offline = mergeInstalledPluginUiProjections(installed, makeRuntime(false), undefined, selectedSources);
    expect(offline?.surfacePlacementsById[String(entry.id)]?.display).toEqual({ title: 'Bundled page' });
    expect(readPluginUiContributionSupplies(offline?.surfacePlacementsById[String(entry.id)]))
        .toMatchObject([{ machineId: 'machine-dev', interactionEnabled: false }]);
});

it('retains the selected launch authority beside host renderer bytes without admitting an unselected or offline supply', () => {
    const pluginId = 'acme.navigation';
    const entry = placementEntry({ pluginId, localId: 'page', container: 'appPage' });
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
        machineId: 'machine-dev', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'source-root' },
    } });
    const declared = { ...machineProjection({ generation: 1, entriesById: { page: {
        ...entry, occurrenceId: undefined, hostSupplies: [], display: { title: 'Host page' },
    } } }), generation: null };
    const source = (online: boolean) => member({ machineId: 'machine-dev', generation: 2,
        producerOriginsByPluginId: { [pluginId]: origin }, interactionEnabled: online,
        entriesById: { page: { ...entry, executionOrigin: origin, display: { title: 'Source page' } } },
    });
    const open = (online: boolean, selected: boolean) => {
        const runtime = unionPluginUiProjections([source(online)], selected ? new Map([[pluginId, origin]]) : new Map()).pluginUiProjection;
        const merged = mergeInstalledPluginUiProjections([declared], runtime)!;
        const placements = selectPluginAppPagePlacements(merged);
        expect(placements[0]?.display).toEqual({ title: 'Host page' });
        return resolvePluginSurfaceDestinationOpen({ placements, targetKind: 'app', accountLifetime: null,
            request: { destination: { pluginId, localId: 'page' }, input: { selected: 'entry' } } });
    };
    expect(open(true, false)).toMatchObject({ ok: false, reason: 'plugin_surface_open_origin_unavailable' });
    expect(open(false, true)).toMatchObject({ ok: false, reason: 'plugin_surface_open_origin_unavailable' });
    expect(open(true, true)).toMatchObject({ ok: true, authority: { machineId: 'machine-dev', occurrenceId: entry.occurrenceId,
        executionOrigin: origin } });
});

it('retains runtime client callback graphs beside host-owned renderer bytes without granting another origin execution', async () => {
    const pluginId = 'acme.client-callbacks';
    const localId = 'select';
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
        artifactId: 'callbacks', tier: 'reactNative', digest,
        entry: 'react-native/callbacks/entry.cjs.bundle',
        files: [{ relativePath: 'react-native/callbacks/entry.cjs.bundle', digest, byteSize: 1 }],
        executable: { exports: ['activate'] },
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, hostUiApiRange: '^1.0.0',
    });
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: digest,
        normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Callbacks', runtime: { apiVersion: 1 },
            contributes: { actions: [{ id: localId, title: 'Select', scopes: ['global'], surfaces: ['ui'], placementBindings: [], dangerLevel: 'safe',
                execution: { target: 'client', client: { artifactId: graph.artifactId, exportName: 'activate' }, platforms: ['web'] } }],
            ui: { renderers: [{ id: 'main', kind: 'reactNative', artifact: 'main', requiredHostMethods: [] }],
                views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, title: 'Callbacks', renderer: 'main' }] } } },
        collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: digest, resources: [] },
    });
    const rendererEntry = 'react-native/main/entry.cjs.bundle';
    const rendererGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
        ...graph, artifactId: 'main', entry: rendererEntry,
        files: [{ relativePath: rendererEntry, digest, byteSize: 1 }],
        executable: { exports: ['renderSurface'] },
    });
    const installed = { ...machineProjection({ generation: 1,
        entriesById: projectPluginPortableUiDeclarationsV1(release.normalizedManifest, [rendererGraph]),
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Callbacks', version: '1.0.0', enabled: true, source: { kind: 'bundled' } } },
    }), generation: null };
    const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test', sourceRef: {
        machineId: 'machine-runtime', pluginId,
        sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'runtime-root' } },
    } });
    const occurrenceId = 'callbacks:1';
    const bundle = { ...projectPluginReactNativeArtifactEntryV1({
        pluginId, pluginVersion: '1.0.0', contributionId: localId, artifactId: graph.artifactId, artifact: graph,
        artifactSelectionOwner: 'daemonProjection', generatedOwnerKind: 'clientContribution', requiredHostMethods: [], exportName: 'activate',
        runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' }, cacheIdentity: { artifactDigest: digest } },
    }), occurrenceId, executionOrigin: origin };
    const action = { ...release.normalizedManifest.contributes.actions[0], pluginId, occurrenceId, available: true, executionOrigin: origin,
        authorization: { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId,
            appliedGeneration: occurrenceId, targetGenerationMode: 'current' }, resourceSelections: [], scopedGrants: [],
            serviceAvailability: [], operatingSystemAuthorization: [] } };
    const runtime = unionPluginUiProjections([member({ machineId: 'machine-runtime', generation: 2,
        entriesById: { [String(bundle.id)]: bundle }, actionsById: { [`${pluginId}/${localId}`]: action },
        producerOriginsByPluginId: { [pluginId]: origin },
    })], selectedOrigins(origin)).pluginUiProjection;
    const merged = mergeInstalledPluginUiProjections([installed], runtime);
    const targets = (projection: typeof merged) => resolveProjectedPluginUiClientExecutables({ actionProjection: projection ? { projection } : null, platform: 'web' });

    const expectedTargets = [{ pluginId, occurrenceId, executionOrigin: origin, target: { artifactId: 'callbacks', exportName: 'activate' } }];
    expect(targets(runtime)).toMatchObject(expectedTargets);
    expect(targets(merged)).toMatchObject(expectedTargets);
    const rendererId = `reactNativeBundle:${pluginId}:main`;
    expect(merged?.reactNativeBundlesById[rendererId]).toBe(installed.reactNativeBundlesById[rendererId]);
    expect(merged?.reactNativeBundlesById[String(bundle.id)]).toBe(runtime?.reactNativeBundlesById[String(bundle.id)]);
    if (!merged) throw new Error('Expected merged plugin projection');
    expect(targets({ ...merged, actionsById: {} })).toEqual([]);
    const currentBundle = merged.reactNativeBundlesById[String(bundle.id)];
    const currentOrigin = readPluginUiContributionOrigin(currentBundle);
    expect(targets({ ...merged, reactNativeBundlesById: { ...merged.reactNativeBundlesById,
        [String(bundle.id)]: { ...currentBundle, hostOrigin: { ...currentOrigin, machineId: 'another-machine' } },
    } })).toEqual([]);

    // Consume the real producer → union → installed merge → executable resolver
    // output at dispatch. Descriptor presence alone does not prove activation.
    const target = targets(merged)[0];
    if (!target) throw new Error('Expected external plugin client target');
    const cache = createPluginReactNativeBundleCache();
    cache.putInstalledArtifact({ identity: target.cacheIdentity, bytes: new Uint8Array([0]), format: 'plainJs' });
    const composition = getInstalledPluginUiClientExecutableComposition();
    await composition.unload();
    try {
        const attempts = await composition.reconcile([{
            pluginId: target.pluginId, pluginVersion: target.pluginVersion,
            hostUiApiRange: target.hostUiApiRange, contributes: target.contributes,
            target: target.target, executionOrigin: target.executionOrigin,
            occurrenceId: target.occurrenceId, authority: target.authority,
            identity: target.cacheIdentity, moduleReference: target.moduleReference, cache,
            isCurrent: () => true,
            // Installed bundle evaluation is the system boundary; registration,
            // activation commit, exact resolution and dispatch remain real.
            backend: { backendId: 'commonJs', available: true, loadInstalledBundle: async () =>
                (api: PluginClientApi) => { api.actions.register(localId, async input => ({ selected: input })); } },
        }]);
        expect(attempts).toMatchObject([{ result: { ok: true } }]);
        expect(await dispatchPluginSurfaceAction({
            callerPluginId: pluginId, action: { pluginId, localId }, input: 'linked-session',
            clientAction: {}, resolveContributedAction: createPluginUiProjectedActionResolver(merged.actionsById),
            hostAction: { execute: createActionExecutor(createActionExecutorBoundaryFixture({})).execute,
                context: { authority: 'present_user' } },
        })).toEqual({ ok: true, result: { selected: 'linked-session' } });
    } finally { await composition.unload(); }
});

it('indexes declaration families once per projection when comparing a wide fleet catalog', () => {
    const unionPluginUiProjections = projectionUnion.createPluginUiProjectionUnionPublication().publish;
    const entries = Array.from({ length: 24 }, (_, index) => placementEntry({
        pluginId: `acme.wide-${index}`, localId: 'panel', container: 'appPage',
    }));
    const entriesById = Object.fromEntries(entries.map(entry => [entry.id, entry]));
    const members = ['machine-a', 'machine-b'].map(machineId => member({ machineId, generation: 1, entriesById }));
    const maps = members.map(input => input.projection!.surfacePlacementsById);
    const enumeration = vi.spyOn(Object, 'entries');
    try {
        const first = unionPluginUiProjections(members, selectedOrigins(selectedOrigin('acme.wide-0', 'machine-a')));
        const second = unionPluginUiProjections(members, selectedOrigins(selectedOrigin('acme.wide-0', 'machine-b')));
        const scans = enumeration.mock.calls.filter(([value]) => maps.some(map => map === value)).length;
        console.info('R-C wide catalog declaration scans', { plugins: entries.length, members: members.length, unions: 2, scans });
        expect(scans).toBeLessThanOrEqual(8);
        expect(Object.keys(first.pluginUiProjection!.surfacePlacementsById)).toHaveLength(entries.length);
        expect(Object.keys(second.pluginUiProjection!.surfacePlacementsById)).toHaveLength(entries.length);
        expect(readPluginUiContributionOrigin(first.pluginUiProjection!.surfacePlacementsById[entries[0]!.id]))
            .toMatchObject({ machineId: 'machine-a' });
        expect(readPluginUiContributionOrigin(second.pluginUiProjection!.surfacePlacementsById[entries[0]!.id]))
            .toMatchObject({ machineId: 'machine-b' });
    } finally { enumeration.mockRestore(); }
});

it('publishes each admitted supply without searching the fleet for its own member', () => {
    const entry = placementEntry({ pluginId: 'acme.supply', localId: 'panel', container: 'appPage' });
    const members = Array.from({ length: 16 }, (_, index) => member({
        machineId: `machine-${String(index).padStart(2, '0')}`, generation: 1, entriesById: { [entry.id]: entry },
    }));
    // Observe real fleet searches; the union, admission and projection codecs still run.
    const search = vi.spyOn(Array.prototype, 'find');
    let scans: number;
    let projection: ReturnType<typeof unionPluginUiProjections>;
    try {
        projection = unionPluginUiProjections(members);
        scans = search.mock.contexts.filter(context => Array.isArray(context)
            && context.length === members.length && context[0] === members[0]
            && context.at(-1) === members.at(-1)).length;
    } finally { search.mockRestore(); }
    const supplies = readPluginUiContributionSupplies(projection.pluginUiProjection!.surfacePlacementsById[entry.id]);
    expect(supplies.map(supply => supply.machineId)).toEqual(members.map(input => input.machineId));
    expect(scans).toBe(0);
});

it('does not rescan retained union members during unchanged renders', () => {
    const entry = placementEntry({ pluginId: 'acme.retained-comparison', localId: 'panel', container: 'appPage' });
    const members = Array.from({ length: 32 }, (_, index) => member({ machineId: `machine-${index}`,
        generation: 1, entriesById: { [entry.id]: entry } }));
    const comparisons = vi.spyOn(originEquality, 'arePluginMachineExecutionOriginsEqual');
    try {
        for (let index = 0; index < 100; index += 1) {
            expect(arePluginUiProjectionUnionMembersEquivalent(members, members)).toBe(true);
            expect(arePluginUiProjectionUnionMembersEquivalent(members, [...members])).toBe(true);
        }
        console.info('R-C retained union member comparisons', { members: 32, reads: 200, originComparisons: comparisons.mock.calls.length });
        expect(comparisons).toHaveBeenCalledTimes(0);
        // A newly produced member still has to observe withdrawal and unsupported disposition.
        expect(arePluginUiProjectionUnionMembersEquivalent(members, members.map((input, index) => index === 0
            ? { ...input, phase: 'unavailable', unavailableReasonCode: 'daemon_unsupported', interactionEnabled: false } : input))).toBe(false);
    } finally { comparisons.mockRestore(); }
});

it('keeps independent mounted-reader merges from invalidating the AppShell merge of the same declaration', () => {
    const entry = placementEntry({ pluginId: 'acme.shared-merge', localId: 'panel', container: 'appPage' });
    const installed = { ...machineProjection({ generation: 1, entriesById: { [entry.id]: { ...entry, occurrenceId: undefined } } }), generation: null };
    const shellRuntime = machineProjection({ generation: 2, entriesById: { [entry.id]: entry } });
    const mountedRuntime = machineProjection({ generation: 3, entriesById: { [entry.id]: entry } });
    const shellPublication = projectionUnion.createInstalledPluginUiProjectionPublication();
    const mountedPublication = projectionUnion.createInstalledPluginUiProjectionPublication();
    const shell = shellPublication.publish([installed], shellRuntime);
    const mounted = mountedPublication.publish([installed], mountedRuntime);
    let recomputations = 0;
    for (let index = 0; index < 100; index += 1) {
        if (shellPublication.publish([installed], shellRuntime) !== shell) recomputations += 1;
        if (mountedPublication.publish([installed], mountedRuntime) !== mounted) recomputations += 1;
    }
    console.info('R-C shared merge counts', { inputs: 2, reads: 200, recomputations });
    expect(recomputations).toBe(0);
    expect(shell?.generation).toBe(2);
    expect(mounted?.generation).toBe(3);
    expect(mergeInstalledPluginUiProjections([installed], null)?.generation).toBeNull();
    expect(shellPublication.getSnapshot()).toBe(shell);
    expect(shellPublication.publish([installed], shellRuntime)).toBe(shell);
});

it('does not remerge unchanged origin selections when another selectable origin report republishes the map', () => {
    const mergeInstalledPluginUiProjections = projectionUnion.createInstalledPluginUiProjectionPublication().publish;
    const pluginId = 'acme.equal-selection';
    const entry = placementEntry({ pluginId, localId: 'panel', container: 'appPage' });
    const installed = { ...machineProjection({ generation: 1, entriesById: { [entry.id]: entry } }), generation: null };
    const runtime = machineProjection({ generation: 2, entriesById: { [entry.id]: entry } });
    const origin = selectedOrigin(pluginId, 'machine-a');
    const merged = mergeInstalledPluginUiProjections([installed], runtime, undefined, selectedOrigins(origin));
    let recomputations = 0;
    for (let index = 0; index < 100; index += 1) {
        if (mergeInstalledPluginUiProjections([installed], runtime, undefined, selectedOrigins({ ...origin })) !== merged) recomputations += 1;
    }
    console.info('R-C equal-selection merge counts', { reads: 100, recomputations });
    expect(recomputations).toBe(0);
    // These declarations have no development override, so an irrelevant
    // selection change also retains their unchanged descriptive output.
    expect(mergeInstalledPluginUiProjections([installed], runtime, undefined,
        selectedOrigins(selectedOrigin(pluginId, 'machine-b')))).toBe(merged);
    expect(mergeInstalledPluginUiProjections([installed], runtime, undefined, new Map())).toBe(merged);
});

it('reuses the live occurrence for the same declared root without confusing runtime identity with content', () => {
    const mergeInstalledPluginUiProjections = projectionUnion.createInstalledPluginUiProjectionPublication().publish;
    const pluginId = 'acme.channels';
    const entry = placementEntry({ pluginId, localId: 'channels', container: 'appPage' });
    const declarative = {
        identity: { pluginId, localId: 'inspector', qualifiedId: `${pluginId}/inspector` },
        visible: true, requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: 'Channels' },
    };
    const declaredEntry = { ...entry, occurrenceId: undefined, renderer: { kind: 'declarative', contributionId: 'inspector', model: declarative } };
    const runtimeEntry = { ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model: {
        ...declarative, identity: { ...declarative.identity, occurrenceId: entry.occurrenceId },
    } } };
    const declared = { ...machineProjection({ generation: 1, entriesById: { [String(entry.id)]: declaredEntry } }), generation: null };
    const runtime = machineProjection({ generation: 7, entriesById: { [String(entry.id)]: runtimeEntry } });
    const installed = [declared];
    const merged = mergeInstalledPluginUiProjections(installed, runtime);
    expect(merged?.surfacePlacementsById[String(entry.id)])
        .toBe(runtime.surfacePlacementsById[String(entry.id)]);
    // Observe real serialization rather than replacing the declaration comparator.
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
        // AppShell creates a new wrapper when another Machine reports. The
        // immutable projection inputs, rather than that wrapper, own identity.
        const repeated = Array.from({ length: 100 }, () => mergeInstalledPluginUiProjections([...installed], runtime));
        expect(serialize).toHaveBeenCalledTimes(0);
        expect(repeated.every(value => value === merged)).toBe(true);
    } finally {
        serialize.mockRestore();
    }
    const replacementRuntime = { ...runtime, generation: 8 };
    expect(mergeInstalledPluginUiProjections(installed, replacementRuntime)).not.toBe(merged);
    expect(mergeInstalledPluginUiProjections(installed, null)?.generation).toBeNull();
    const changed = { ...declared, surfacePlacementsById: { ...declared.surfacePlacementsById,
        [String(entry.id)]: { ...declared.surfacePlacementsById[String(entry.id)]!, renderer: { ...declaredEntry.renderer,
            model: { ...declarative, root: { ...declarative.root, text: 'New content' } } } } } };
    expect(mergeInstalledPluginUiProjections([changed], runtime)?.surfacePlacementsById[String(entry.id)]?.occurrenceId).toBeUndefined();
});

it('compares fleet declarations without re-admitting models and rejects changed authored content', () => {
    const unionPluginUiProjections = projectionUnion.createPluginUiProjectionUnionPublication().publish;
    const pluginId = 'acme.stable-declaration';
    const entry = placementEntry({ pluginId, localId: 'stable', container: 'appPage' });
    const model = {
        identity: { pluginId, localId: 'inspector', qualifiedId: `${pluginId}/inspector` },
        visible: true, requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: 'Stable declaration' },
    };
    const members = ['machine-a', 'machine-b'].map(machineId => member({ machineId, generation: 1, entriesById: {
        [entry.id]: { ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model } },
    } }));
    // Observe the real decoder without replacing validation or union policy.
    const parse = vi.spyOn(PluginDeclarativeProjectedModelV1Schema, 'safeParse');
    const serialize = vi.spyOn(JSON, 'stringify');
    const containsRenderedModel = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(containsRenderedModel);
        if (!value || typeof value !== 'object') return false;
        if ('root' in value && 'requiredHostMethods' in value) return true;
        return Object.values(value).some(containsRenderedModel);
    };
    try {
        const initial = unionPluginUiProjections(members);
        expect(initial.pluginUiProjection?.surfacePlacementsById[entry.id]).toBeDefined();
        expect(parse).not.toHaveBeenCalled();
        parse.mockClear();
        serialize.mockClear();
        unionPluginUiProjections([...members], selectedOrigins(selectedOrigin(pluginId, 'machine-b')));
        expect(parse).not.toHaveBeenCalled();
        // Fleet selection changes must not serialize the unchanged renderer
        // tree again. Observe real JSON inputs, without replacing the codec.
        expect(serialize.mock.calls.filter(([value]) => containsRenderedModel(value))).toHaveLength(0);
        const changed = member({ machineId: 'machine-b', generation: 2, entriesById: {
            [entry.id]: { ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model: {
                ...model, root: { ...model.root, text: 'Changed declaration' },
            } } },
        } });
        const replaced = unionPluginUiProjections([members[0]!, changed]);
        expect(replaced.pluginUiProjection?.surfacePlacementsById[entry.id]).toMatchObject({ hostCompatibility: 'conflict' });
        expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); serialize.mockRestore(); }
});

it('does not walk unchanged authored declarations when currentness republishes a union into the installed merge', () => {
    const pluginId = 'acme.currentness-comparison';
    const entry = placementEntry({ pluginId, localId: 'stable', container: 'appPage' });
    const model = {
        identity: { pluginId, localId: 'inspector', qualifiedId: `${pluginId}/inspector` },
        visible: true, requiredHostMethods: [],
        declarativeInventory: { actions: [], destinations: [], settings: [], uiQueries: [] },
        root: { kind: 'text', path: 'root', order: 0, text: 'Unchanged authored declaration' },
    };
    const declared = { ...machineProjection({ generation: 1, entriesById: { [entry.id]: {
        ...entry, occurrenceId: undefined, renderer: { kind: 'declarative', contributionId: 'inspector', model: projectNativeJsonValueForTransport(model) },
    } } }), generation: null };
    const origin = selectedOrigin(pluginId, 'machine-a');
    const current = member({ machineId: 'machine-a', generation: 1, entriesById: { [entry.id]: {
        ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model: projectNativeJsonValueForTransport({
            ...model, identity: { ...model.identity, occurrenceId: entry.occurrenceId },
        }) },
    } } });
    const union = projectionUnion.createPluginUiProjectionUnionPublication();
    const installed = projectionUnion.createInstalledPluginUiProjectionPublication();
    const publish = (generation: number) => installed.publish([declared], union.publish([{
        ...current, projection: { ...current.projection!, generation },
    }], selectedOrigins(origin)).pluginUiProjection);
    const firstPublished = publish(1);
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    const values = vi.spyOn(Object, 'values');
    const parseModel = vi.spyOn(PluginDeclarativeProjectedModelV1Schema, 'safeParse');
    try {
        for (let generation = 2; generation <= 101; generation += 1) publish(generation);
        const walks = descriptors.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
            && Reflect.getOwnPropertyDescriptor(value, 'text')?.value === model.root.text).length;
        expect(walks).toBe(0);
        expect(parseModel).not.toHaveBeenCalled();
        const unchangedDictionaryWalks = values.mock.calls.filter(([value]) => value === current.projection!.surfacePlacementsById).length;
        expect(unchangedDictionaryWalks).toBe(0);
        expect(installed.getSnapshot()).toBe(firstPublished);
    } finally { descriptors.mockRestore(); values.mockRestore(); parseModel.mockRestore(); }

    const rawModel = Object.freeze({ ...model, identity: { ...model.identity, occurrenceId: entry.occurrenceId }, root: { ...model.root } });
    const rawMerge = projectionUnion.createInstalledPluginUiProjectionPublication();
    const readRaw = () => rawMerge.publish([declared], machineProjection({ generation: 102, entriesById: { [entry.id]: {
        ...entry, renderer: { kind: 'declarative', contributionId: 'inspector', model: rawModel },
    } } }));
    expect(readRaw()?.surfacePlacementsById[entry.id]?.occurrenceId).toBe(entry.occurrenceId);
    // A caller-frozen model does not prove admission of its mutable root.
    rawModel.root.text = 'Changed authored declaration';
    const rejected = readRaw()?.surfacePlacementsById[entry.id];
    expect(rejected?.occurrenceId).toBeUndefined();
    expect(rejected?.renderer.model).toMatchObject({ root: { text: model.root.text } });
});

it('compares declaration snapshots without serialization while preserving native optional fields and authored payloads', () => {
    const declaredEntry = Object.freeze({ pluginId: 'acme.fixture', occurrenceId: undefined,
        payload: { first: 'value', optional: undefined, items: [1, { enabled: false }] } });
    const runtimeEntry = Object.freeze({ pluginId: 'acme.fixture', occurrenceId: 'runtime:1',
        payload: { items: [1, { enabled: false }], first: 'value' } });
    const declared = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, unknownEntriesById: { entry: declaredEntry } });
    const runtime = Object.freeze({ ...EMPTY_PLUGIN_UI_PROJECTION, unknownEntriesById: { entry: runtimeEntry } });
    const serialize = vi.spyOn(JSON, 'stringify');
    try {
        const merged = mergeInstalledPluginUiProjections([declared], runtime);
        expect(merged?.unknownEntriesById.entry).toBe(runtimeEntry);
        expect(serialize).not.toHaveBeenCalled();
    } finally { serialize.mockRestore(); }
    // Equal generation or a shared plugin id cannot stand in for declaration content.
    const replacement = { ...runtime, unknownEntriesById: { entry: { ...runtimeEntry,
        payload: { ...runtimeEntry.payload, items: [1, { enabled: true }] } } } };
    expect(mergeInstalledPluginUiProjections([declared], replacement)?.unknownEntriesById.entry).toBe(declaredEntry);
});

it('retains the declaring installation default beside each exact contribution supply', () => {
    const pluginId = 'acme.channels';
    const entry = placementEntry({ pluginId, localId: 'channels', container: 'appPage' });
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'channels-source' };
    const project = (autoPick?: false) => unionPluginUiProjections(['machine-a', 'machine-b'].map(machineId => member({ machineId, generation: 1,
        producerOriginsByPluginId: { [pluginId]: { serverIdentityId: 'srv_test', sourceRef: { machineId, pluginId, sourceCustody } } },
        entriesById: { [String(entry.id)]: entry }, installedPackagesById: { [pluginId]: {
            id: pluginId, displayName: 'Channels', version: '1.0.0', enabled: true,
            source: { kind: 'localPath' }, occurrenceId: entry.occurrenceId, sourceCustody,
            executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId, pluginId, sourceCustody } },
            executionTarget: { default: 'installation', ...(autoPick === undefined ? {} : { autoPick }) },
        } } }))).pluginUiProjection;
    const projection = project(false);
    expect(readPluginUiContributionSupplies(projection?.surfacePlacementsById[String(entry.id)])[0])
        .toMatchObject({ executionTargetDefault: true, executionTargetAutoPick: false });
    expect(readPluginUiExecutionOriginCandidates({ projection, pluginId })).toMatchObject({ autoPick: false, renderedVersion: '1.0.0' });
    const resolve = (projection: PluginUiProjectionUnionMember['projection']) => {
        const facts = readPluginUiExecutionOriginCandidates({ projection, pluginId });
        expect(facts.sourceCandidates).toHaveLength(2);
        return resolvePluginMachineExecutionOriginState({ pluginId, storedOrigin: null, ...facts, candidates: facts.sourceCandidates });
    };
    expect(resolve(projection)).toMatchObject({ kind: 'selectionRequired' });
    expect(resolve(project())).toMatchObject({ kind: 'selected', selectionSource: 'auto', origin: { sourceRef: { machineId: 'machine-a' } } });
    const current = project()!;
    const page = current.surfacePlacementsById[String(entry.id)]!;
    const mixed = { ...current, surfacePlacementsById: { [String(entry.id)]: { ...page,
        hostSupplies: readPluginUiContributionSupplies(page).map((supply, index) => index === 0
            ? { ...supply, pluginVersion: '0.9.0', executionTargetAutoPick: false } : supply),
    } } };
    expect(readPluginUiExecutionOriginCandidates({ projection: mixed, pluginId })).toMatchObject({ autoPick: true, renderedVersion: '1.0.0' });
    expect(resolve(mixed)).toMatchObject({ kind: 'selected', selectionSource: 'auto', origin: { sourceRef: { machineId: 'machine-b' } } });
});

it('projects only a real current source occurrence for execution and retains its exact offline identity', () => {
    const pluginId = 'acme.local';
    const entry = placementEntry({ pluginId, localId: 'local', container: 'appPage' });
    const occurrenceId = String(entry.occurrenceId);
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'registered-root-a' };
    const source: PluginUiProjectionUnionMember = {
        machineId: 'machine-a', serverId: 'server-1', serverIdentityId: 'srv_test', phase: 'current', interactionEnabled: true,
        projection: machineProjection({ generation: 7, entriesById: { [String(entry.id)]: entry }, installedPackagesById: {
            [pluginId]: { id: pluginId, displayName: 'Local', version: '1.0.0', enabled: true, source: { kind: 'localPath' },
                occurrenceId, sourceCustody, executionTarget: { default: 'installation' },
                executionOrigin: PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_test',
                    sourceRef: { machineId: 'machine-a', pluginId, sourceCustody } }) },
        } }),
    };
    const read = (member: PluginUiProjectionUnionMember) => readPluginUiExecutionOriginCandidates({
        projection: unionPluginUiProjections([member]).pluginUiProjection, pluginId,
    });
    const retainedProjection = unionPluginUiProjections([source]).pluginUiProjection;
    const retainedCandidates = readPluginUiExecutionOriginCandidates({ projection: retainedProjection, pluginId });
    const entries = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
        const contribution = placementEntry({ pluginId, localId: `page-${index}`, container: 'appPage' });
        return [contribution.id, { ...contribution, occurrenceId }];
    }));
    const manySource = { ...source, projection: machineProjection({
        generation: 7, entriesById: entries, installedPackagesById: source.projection!.installedPackagesById,
    }) };
    // Forward both schema readers: this observes real admission work, not a mock decision.
    const originParse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
    const custodyParse = vi.spyOn(PluginSourceCustodyV1Schema, 'safeParse');
    try {
        const many = unionPluginUiProjections([manySource]).pluginUiProjection;
        expect(Object.keys(many!.surfacePlacementsById)).toHaveLength(100);
        expect(readPluginUiExecutionOriginCandidates({ projection: many, pluginId })).toEqual(retainedCandidates);
        // All declarations share one producer occurrence. Revalidating that
        // same origin and custody per declaration is fleet-wide repeated work.
        expect(originParse).toHaveBeenCalledTimes(1);
        expect(custodyParse).toHaveBeenCalledTimes(1);
        originParse.mockClear();
        custodyParse.mockClear();
        for (let index = 0; index < 100; index++) {
            expect(readPluginUiExecutionOriginCandidates({ projection: retainedProjection, pluginId })).toEqual(retainedCandidates);
        }
        expect(originParse).toHaveBeenCalledTimes(0);
        expect(custodyParse).toHaveBeenCalledTimes(0);
    } finally {
        originParse.mockRestore();
        custodyParse.mockRestore();
    }
    // Unknown/mutable in-memory stamps still pass through the actual parsers on every read.
    const mutableSupply = { ...readPluginUiContributionSupplies(retainedProjection?.surfacePlacementsById[entry.id])[0]!,
        sourceCustody: { kind: 'development', registeredRootId: 'original-root' } };
    const mutableEntry = { hostSupplies: [mutableSupply] };
    expect(readPluginUiContributionSupplies(mutableEntry)[0]?.sourceCustody)
        .toEqual({ kind: 'development', registeredRootId: 'original-root' });
    mutableSupply.sourceCustody.registeredRootId = 'replacement-root';
    expect(readPluginUiContributionSupplies(mutableEntry)[0]?.sourceCustody)
        .toEqual({ kind: 'development', registeredRootId: 'replacement-root' });
    mutableSupply.sourceCustody.kind = 'invalid';
    expect(readPluginUiContributionSupplies(mutableEntry)[0]?.sourceCustody).toBeNull();
    // Freezing an arbitrary array is not a producer validation proof, nor does
    // it freeze the nested facts a caller can replace between reads.
    const frozenEntry = { hostSupplies: Object.freeze([mutableSupply]) };
    expect(readPluginUiContributionSupplies(frozenEntry)[0]?.sourceCustody).toBeNull();
    mutableSupply.sourceCustody.kind = 'development';
    expect(readPluginUiContributionSupplies(frozenEntry)[0]?.sourceCustody)
        .toEqual({ kind: 'development', registeredRootId: 'replacement-root' });
    expect(read(source).sourceCandidates).toEqual([expect.objectContaining({ source: {
        origin: { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine-a', pluginId, sourceCustody } },
        version: '1.0.0', occurrenceId, serverId: 'server-1',
    }, validation: { kind: 'admitted' } })]);
    const unstamped = { ...source, projection: { ...source.projection!, installedPackagesById: {
        ...source.projection!.installedPackagesById,
        [pluginId]: { ...source.projection!.installedPackagesById[pluginId]!, executionOrigin: undefined },
    } } };
    expect(read(unstamped).sourceCandidates).toEqual([]);
    expect(read(source).declaredDefaultOrigins).toEqual([read(source).sourceCandidates[0]!.source.origin]);
    expect(read({ ...source, phase: 'retainedOffline', interactionEnabled: false }).sourceCandidates[0])
        .toMatchObject({ source: { occurrenceId, origin: read(source).sourceCandidates[0]!.source.origin }, validation: { kind: 'rejected', reason: 'stale' } });
    for (const [unavailableReasonCode, reason] of [
        ['plugin_machine_unreachable', 'home_unreachable'],
        ['plugin_daemon_unsupported', 'daemon_unsupported'],
        ['plugin_daemon_invalid_response', 'daemon_invalid_response'],
    ] as const) {
        const refused = read({ ...source, phase: 'unavailable', interactionEnabled: false, unavailableReasonCode });
        expect(refused.sourceCandidates[0]?.validation).toEqual({ kind: 'rejected', reason });
        expect(refused.machineRejections).toEqual([{ serverIdentityId: 'srv_test', machineId: 'machine-a', reason }]);
    }
    const revoked: PluginMachineMaterializationV1 = { serverIdentityId: 'srv_test', machineId: 'machine-a',
        materializationId: 'source-observation', pluginId, version: '1.0.0', sourceClass: 'localPath',
        portableRelease: false, uiArtifacts: [], enabled: false, trustState: 'revoked', observedAt: 2 };
    expect(read({ ...source, materializationsByPluginId: { [pluginId]: revoked } }).sourceCandidates[0]?.validation.kind)
        .toBe('rejected');
});

it('retains an activation refusal for a release-less external installation without inventing source custody', () => {
    const pluginId = 'com.acme.failed';
    const diagnostic = {
        version: 1, id: 'activation-diagnostic', data: { code: 'plugin_activation_failed', severity: 'error' },
        plugin: { id: pluginId, version: '0.0.0', source: 'development' }, stage: 'activation',
        host: 'daemon', platform: 'linux', occurredAtMs: 1, resolution: { state: 'current' },
    };
    const read = (resolved: boolean, host = 'daemon') => {
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({
            v: 2, generation: 1, familiesById: {}, installedPackagesById: { [pluginId]: {
                id: pluginId, displayName: 'External plugin', version: '0.0.0', enabled: true,
                source: { kind: 'localPath', locator: '/plugins/external-fixture' },
            } }, diagnostics: [{ ...diagnostic, host, ...(resolved ? { resolution: { state: 'resolved', resolvedAtMs: 2 } } : {}) }],
        }));
        return readPluginUiExecutionOriginCandidates({ pluginId, projection: null, members: [{
            machineId: 'machine-a', serverId: 'server-1', serverIdentityId: 'srv_test', projection,
            phase: 'current', interactionEnabled: true,
        }] });
    };
    expect(read(false).sourceCandidates).toEqual([]);
    expect(read(false).machineRejections).toEqual([{ serverIdentityId: 'srv_test', machineId: 'machine-a', reason: 'activation_refused' }]);
    expect(read(true).machineRejections).toEqual([]);
    expect(read(false, 'web').machineRejections).toEqual([]);
});

it('admits package occurrences without UI while preserving source trust and portable release admission', () => {
    const pluginId = 'acme.native-only';
    const source: PluginUiProjectionUnionMember = { machineId: 'machine-a', serverId: 'server-1', serverIdentityId: 'srv_test',
        phase: 'current', interactionEnabled: true, projection: machineProjection({ generation: 7, entriesById: {},
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Native only', version: '1.0.0', enabled: true,
                source: { kind: 'localPath' }, occurrenceId: `${pluginId}:occurrence`,
                executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId: 'machine-a', pluginId,
                    sourceCustody: { kind: 'development', registeredRootId: 'native-only-root' } } },
                sourceCustody: { kind: 'development', registeredRootId: 'native-only-root' } } } }) };
    const read = (input: PluginUiProjectionUnionMember) => readPluginUiExecutionOriginCandidates({ projection: null, pluginId, members: [input] });
    expect(read(source).sourceCandidates).toEqual([expect.objectContaining({ validation: { kind: 'admitted' } })]);
    // A release-less source needs exact custody, never a portable release or a version heuristic.
    const releaseLess = { ...source, projection: { ...source.projection!, installedPackagesById: {
        [pluginId]: { ...source.projection!.installedPackagesById[pluginId]!, version: '0.0.0' },
    } } };
    expect(read(releaseLess).sourceCandidates).toEqual([expect.objectContaining({
        releaseContent: 'matched', validation: { kind: 'admitted' }, source: expect.objectContaining({ version: '0.0.0' }),
    })]);
    const observed: PluginMachineMaterializationV1 = { serverIdentityId: 'srv_test', machineId: 'machine-a',
        materializationId: 'observed-source', pluginId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
        uiArtifacts: [], enabled: false, trustState: 'revoked', observedAt: 2 };
    expect(read({ ...source, materializationsByPluginId: { [pluginId]: observed } }).sourceCandidates[0]?.validation.kind).toBe('rejected');
    expect(read({ ...source, materializationsByPluginId: { [pluginId]: {
        ...observed, enabled: true, trustState: 'trusted', portableRelease: true, sourceClass: 'registryPackage',
    } } }).sourceCandidates).toEqual([]);
});

it('does not recreate a conflicted declaration default through package supplies', () => {
    const pluginId = 'acme.source-conflict';
    const entry = placementEntry({ pluginId, localId: 'settings', container: 'appPage' });
    const source = (machineId: string, declaringDefault: boolean): PluginUiProjectionUnionMember => ({
        machineId, serverId: 'server-1', serverIdentityId: 'srv_test', phase: 'current', interactionEnabled: true,
        selectableExecutionOrigins: [{ serverIdentityId: 'srv_test', sourceRef: { machineId, pluginId,
            sourceCustody: { kind: 'development', registeredRootId: `root-${machineId}` } } }],
        projection: machineProjection({ generation: 7, entriesById: { [entry.id]: entry },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Source', version: declaringDefault ? '1.0.0' : '2.0.0', enabled: true,
                source: { kind: 'localPath' }, occurrenceId: entry.occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: `root-${machineId}` },
                executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId, pluginId,
                    sourceCustody: { kind: 'development', registeredRootId: `root-${machineId}` } } },
                ...(declaringDefault ? { executionTarget: { default: 'installation' } } : {}) } } }),
    });
    const members = [source('machine-a', true), source('machine-b', false)];
    const projection = unionPluginUiProjections(members).pluginUiProjection;
    const conflicted = projection?.surfacePlacementsById[entry.id];
    expect(conflicted?.hostCompatibility).toBe('conflict');
    const candidates = readPluginUiExecutionOriginCandidates({ projection, pluginId, entry: conflicted, members });
    expect(candidates.sourceCandidates).toHaveLength(2);
    expect(candidates.declaredDefaultOrigins).toEqual([]);
});

function machineProjection(input: Readonly<{
    generation: number;
    entriesById: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    resourcesById?: Readonly<Record<string, unknown>>;
    inputTypesById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
}>) {
    return normalizePluginUiProjection({
        v: 2,
        generation: input.generation,
        installedPackagesById: input.installedPackagesById ?? {},
        agentsById: {},
        actionsById: input.actionsById ?? {},


        resourcesById: input.resourcesById ?? {},
        settingsById: {},
        familiesById: {
            pluginUi: { family: 'pluginUi', entriesById: input.entriesById },
            inputTypes: { family: 'inputTypes', entriesById: input.inputTypesById ?? {} },
        },
        diagnostics: [],
    } as never);
}

it('keeps machine-local source candidates selectable across different web artifact supplies', () => {
    const pluginId = 'acme.local';
    const entry = placementEntry({ pluginId, localId: 'settings', container: 'appPage' });
    const rendererId = `hostedWeb:${pluginId}:settings`;
    const sourceCustody = { kind: 'development' as const, registeredRootId: 'local-root' };
    const replica = (machineId: string, digest: string): PluginUiProjectionUnionMember => ({
        machineId, serverId: 'server-1', serverIdentityId: 'srv_test', phase: 'current', interactionEnabled: true,
        projection: machineProjection({ generation: 7, entriesById: { [entry.id]: entry,
            [rendererId]: { id: rendererId, pluginId, occurrenceId: entry.occurrenceId, contributionKind: 'hostedWeb',
                contributionId: 'settings', artifactSelectionOwner: 'daemonProjection', artifactDigest: `sha256:${digest.repeat(64)}` },
        }, installedPackagesById: {
            [pluginId]: { id: pluginId, displayName: 'Local', version: '1.0.0', enabled: true, source: { kind: 'localPath' },
                occurrenceId: entry.occurrenceId, sourceCustody,
                executionOrigin: { serverIdentityId: 'srv_test', sourceRef: { machineId, pluginId, sourceCustody } } },
        } }),
        materializationsByPluginId: { [pluginId]: { serverIdentityId: 'srv_test', machineId, pluginId,
            materializationId: machineId, version: '1.0.0', sourceClass: 'localPath', portableRelease: false,
            enabled: true, trustState: 'trusted', observedAt: 1,
            uiArtifacts: [{ contributionId: 'settings', artifactId: 'web', tier: 'hostedWeb', platform: 'web',
                artifactDigest: `sha256:${digest.repeat(64)}`, hostUiApiRange: '^1.0.0' }],
        } },
    });
    const members = [replica('machine-b', 'b'), replica('machine-a', 'a')];
    const unselected = unionPluginUiProjections(members).pluginUiProjection;
    const candidates = readPluginUiExecutionOriginCandidates({ projection: unselected, pluginId }).sourceCandidates;
    expect(candidates).toHaveLength(2);
    expect(candidates.every(candidate => candidate.validation.kind === 'admitted')).toBe(true);
    const selected = candidates.find(candidate => candidate.source.origin.sourceRef.machineId === 'machine-b')!.source.origin;
    const project = (input: readonly PluginUiProjectionUnionMember[]) => unionPluginUiProjections(input, selectedOrigins(selected)).pluginUiProjection;
    const projected = project(members);
    const placement = projected?.surfacePlacementsById[entry.id];
    expect(placement).toMatchObject({ hostCompatibility: 'compatible', availability: { state: 'available' } });
    expect(readPluginUiContributionOrigin(placement)).toMatchObject({ machineId: 'machine-b', executionOrigin: selected });
    const renderer = projected?.hostedWebById[rendererId] ?? null;
    expect(renderer?.artifactDigest).toBe(`sha256:${'b'.repeat(64)}`);
    expect(readPluginUiDaemonProjectionSelection(renderer)).toMatchObject({
        occurrenceId: entry.occurrenceId, releaseVersion: '1.0.0',
        transport: { machineId: 'machine-b', serverId: 'server-1' },
    });
    expect(project([...members].reverse())).toEqual(projected);
    const revoked = { ...members[0]!, materializationsByPluginId: { [pluginId]: {
        ...members[0]!.materializationsByPluginId![pluginId]!, trustState: 'revoked' as const,
    } } };
    expect(readPluginUiExecutionOriginCandidates({ projection: project([revoked, members[1]!]), pluginId }).sourceCandidates
        .find(candidate => candidate.source.origin.sourceRef.machineId === 'machine-b')?.validation.kind).toBe('rejected');
});

function placementEntry(input: Readonly<{
    pluginId: string;
    localId: string;
    container?: PluginUiDestinationBindingInputV1['container'];
    target?: PluginUiDestinationBindingInputV1['target'];
    order?: number;
}>) {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: input.pluginId,
        destinationId: input.localId,
        rendererId: 'inspector',
        container: input.container ?? 'rightSidebarTab',
        target: input.target ?? { kind: 'app' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    return {
        id: `surfacePlacement:${input.pluginId}:${input.localId}`,
        pluginId: input.pluginId,
        occurrenceId: `${input.pluginId}:${input.localId}:occurrence`,
        contributionKind: 'surfacePlacement',
        descriptorId: input.localId,
        binding,
        target: binding.target,
        renderer: { kind: 'declarative', contributionId: 'inspector' },
        display: { developerFallback: input.localId },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        ...(input.order === undefined ? {} : { order: input.order }),
    };
}

function reactNativeBundleEntry(pluginId: string): Readonly<Record<string, unknown>> {
    return {
        id: `reactNativeBundle:${pluginId}:bundle`,
        pluginId,
        occurrenceId: `${pluginId}:bundle:occurrence`,
        contributionKind: 'reactNativeBundle',
        contributionId: 'bundle',
    };
}

/** A direct producer stamp, as emitted by the V2 projection owner. */
function stampEntriesWithProducerOrigins(
    entriesById: Readonly<Record<string, unknown>>,
    machineId: string,
    originsByPluginId: Readonly<Record<string, PluginMachineExecutionOriginV1>> | undefined,
): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(entriesById).map(([id, entry]) => {
        const candidate = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Readonly<Record<string, unknown>>
            : null;
        const pluginId = typeof candidate?.pluginId === 'string' ? candidate.pluginId : null;
        if (!candidate || !pluginId) return [id, entry];
        const origin = originsByPluginId?.[pluginId] ?? selectedOrigin(pluginId, machineId);
        return [id, {
            ...candidate,
            executionOrigin: origin,
        }];
    }));
}

function member(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    generation?: number;
    entriesById?: Readonly<Record<string, unknown>>;
    actionsById?: Readonly<Record<string, unknown>>;
    resourcesById?: Readonly<Record<string, unknown>>;
    installedPackagesById?: Readonly<Record<string, unknown>>;
    producerOriginsByPluginId?: Readonly<Record<string, PluginMachineExecutionOriginV1>>;
    phase?: PluginUiProjectionUnionMember['phase'];
    interactionEnabled?: boolean;
    archiveDigest?: `sha256:${string}`;
    uiArtifacts?: PluginMachineMaterializationV1['uiArtifacts'];
}>): PluginUiProjectionUnionMember {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? 'server-1',
        projection: input.generation === undefined
            ? null
            : machineProjection({
                generation: input.generation,
                entriesById: stampEntriesWithProducerOrigins(
                    input.entriesById ?? {},
                    input.machineId,
                    input.producerOriginsByPluginId,
                ),
                actionsById: stampEntriesWithProducerOrigins(
                    input.actionsById ?? {},
                    input.machineId,
                    input.producerOriginsByPluginId,
                ),
                installedPackagesById: input.installedPackagesById,
                resourcesById: input.resourcesById,
        }),
        phase: input.phase ?? (input.interactionEnabled === false ? 'retainedOffline' : 'current'),
        interactionEnabled: input.interactionEnabled ?? true,
        // Administration eligibility is an input fact of this union fixture;
        // runtime currentness alone does not grant exact-origin selectability.
        selectableExecutionOrigins: input.interactionEnabled !== false && (!input.phase || input.phase === 'current')
            ? [...new Set(Object.values(input.entriesById ?? input.actionsById ?? {}).flatMap(entry => {
                const pluginId = (entry as Readonly<Record<string, unknown>>).pluginId;
                return typeof pluginId === 'string' ? [pluginId] : [];
            }))].map(pluginId => input.producerOriginsByPluginId?.[pluginId] ?? selectedOrigin(pluginId, input.machineId))
            : [],
        materializationsByPluginId: Object.fromEntries(Object.values(input.entriesById ?? input.actionsById ?? {})
            .flatMap(entry => {
                const value = entry as Readonly<Record<string, unknown>>;
                if (typeof value.pluginId !== 'string') return [];
                const pluginId = value.pluginId;
                const origin = input.producerOriginsByPluginId?.[pluginId] ?? selectedOrigin(pluginId, input.machineId);
                if (!('materializationRef' in origin)) return [];
                return [[pluginId, { ...origin.materializationRef, serverIdentityId: origin.serverIdentityId,
                    version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true,
                    archiveDigestSha256: input.archiveDigest ?? `sha256:${'a'.repeat(64)}`,
                    uiArtifacts: input.uiArtifacts ?? [], enabled: true, trustState: 'trusted', observedAt: 1 } satisfies PluginMachineMaterializationV1]];
            })),
    };
}

function selectedOrigin(pluginId: string, machineId: string): Extract<PluginMachineExecutionOriginV1, { materializationRef: unknown }> {
    return {
        serverIdentityId: 'srv_test',
        materializationRef: {
            machineId,
            materializationId: `${machineId}:${pluginId}`,
            pluginId,
        },
    };
}

function selectedOrigins(...origins: readonly PluginMachineExecutionOriginV1[]): ReadonlyMap<string, PluginMachineExecutionOriginV1> {
    return new Map(origins.map((origin) => [('materializationRef' in origin ? origin.materializationRef : origin.sourceRef).pluginId, origin]));
}

function composerMember(machineId: string, label = 'Inspect'): PluginUiProjectionUnionMember {
    const pluginId = 'acme.inspector';
    const occurrenceId = `${machineId}:composer`;
    const source = member({ machineId, generation: 3,
        entriesById: { placement: placementEntry({ pluginId, localId: 'panel' }) } });
    return { ...source, projection: normalizePluginUiProjection(PluginProjectionV2Schema.parse({
        v: 2, generation: 3,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Inspector', version: '1.0.0',
            enabled: true, occurrenceId, source: { kind: 'bundled', locator: pluginId },
            executionOrigin: selectedOrigin(pluginId, machineId) } },
        agentsById: {}, actionsById: {},   resourcesById: {}, settingsById: {}, diagnostics: [],
        familiesById: {
            composerControls: { family: 'composerControls', entriesById: {
                [`${pluginId}/inspect`]: { id: `${pluginId}/inspect`, pluginId,
                    identity: { pluginId, localId: 'inspect' }, occurrenceId,
                    definition: { id: 'inspect', label, icon: 'search',
                        interaction: { kind: 'attachmentPicker', attachment: 'report', presentation: 'popover', layout: 'list' } } },
            } },
            composerRegions: { family: 'composerRegions', entriesById: {
                [`${pluginId}/summary`]: { id: `${pluginId}/summary`, pluginId,
                    identity: { pluginId, localId: 'summary' }, occurrenceId,
                    definition: { id: 'summary', placement: 'afterComposer', renderer: { renderer: 'summary' } } },
            } },
        },
    })) };
}

describe('unionPluginUiProjections', () => {
    it('carries strict daemon declarations through the union to settings and app-page catalogs', () => {
        const pageId = 'overview';
        const appBinding = normalizePluginUiDestinationBindingV1({
            pluginId: 'acme.notes', destinationId: pageId, rendererId: 'app-renderer',
            container: 'appPage', target: { kind: 'app' },
        });
        const settingsBinding = normalizePluginUiSettingsPageBindingV1({
            pluginId: 'acme.preferences', pageId, rendererId: 'settings-renderer',
        });
        if (!appBinding || !settingsBinding) throw new Error('The Registry must admit both fixture bindings');
        const appEntry = {
            id: 'surfacePlacement:acme.notes:overview', pluginId: 'acme.notes',
            occurrenceId: 'acme.notes:overview:occurrence',
            contributionKind: 'surfacePlacement', descriptorId: pageId,
            binding: appBinding, target: appBinding.target,
            renderer: { kind: 'declarative', contributionId: 'app-renderer' },
            display: { developerFallback: 'Notes' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        const settingsEntry = {
            id: 'settingsPage:acme.preferences:overview', pluginId: 'acme.preferences',
            occurrenceId: 'acme.preferences:overview:occurrence',
            contributionKind: 'settingsPage', descriptorId: pageId,
            page: {
                id: { pluginId: 'acme.preferences', localId: pageId },
                group: { kind: 'plugin', id: { pluginId: 'acme.preferences', localId: 'general' } },
                title: 'Preferences',
            },
            binding: settingsBinding,
            renderer: { kind: 'declarative', contributionId: 'settings-renderer' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        const strictMember = (machineId: string, entry: object) => {
            const output = PluginProjectionV2Schema.parse({
                v: 2, generation: 4, installedPackagesById: {}, agentsById: {}, actionsById: {},
                  resourcesById: {}, settingsById: {},
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: { page: entry } } },
                diagnostics: [],
            });
            return {
                machineId, serverId: 'server-1', serverIdentityId: 'srv_test',
                phase: 'current' as const, interactionEnabled: true,
                projection: normalizePluginUiProjection(output),
            };
        };
        const union = unionPluginUiProjections([
            strictMember('machine-notes', appEntry),
            strictMember('machine-preferences', settingsEntry),
        ]).pluginUiProjection;
        expect(resolvePluginAppPages({ placements: selectPluginAppPagePlacements(union) })
            .map(page => page.routePath)).toEqual(['/plugins/acme.notes/overview']);
        expect(resolveAdmittedPluginSettingsPage({
            projection: union, pluginId: 'acme.preferences', pageId, locale: 'en',
        })?.title).toBe('Preferences');
        expect(resolveAdmittedPluginSettingsPage({
            projection: union, pluginId: 'acme.notes', pageId, locale: 'en',
        })).toBeNull();

        const malformedSettings = { ...settingsEntry, binding: appBinding };
        const malformedUnion = unionPluginUiProjections([
            strictMember('machine-notes', appEntry),
            strictMember('machine-preferences', malformedSettings),
        ]).pluginUiProjection;
        expect(resolveAdmittedPluginSettingsPage({
            projection: malformedUnion, pluginId: 'acme.preferences', pageId, locale: 'en',
        })).toBeNull();
        expect(resolvePluginAppPages({ placements: selectPluginAppPagePlacements(malformedUnion) })
            .map(page => page.routePath)).toEqual(['/plugins/acme.notes/overview']);
    });

    it('shows Channels on A and Triage on B before any execution or administration selection', () => {
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, entriesById: {
                channels: placementEntry({ pluginId: 'happier.channels', localId: 'conversations', container: 'appPage' }),
            } }),
            member({ machineId: 'machine-b', generation: 2, entriesById: {
                triage: placementEntry({ pluginId: 'happier.triage', localId: 'triage', container: 'appPage' }),
            } }),
        ], new Map());
        expect(union.pluginUiProjection).not.toBeNull();
        expect(selectPluginSurfacePlacementsForBinding(union.pluginUiProjection!, {
            container: 'appPage', targetKind: 'app',
        }).map(entry => entry.pluginId)).toEqual(['happier.channels', 'happier.triage']);
    });

    it('keeps identical portable declarations visible without electing an execution origin', () => {
        const entries = { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes', container: 'appPage' }) };
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, entriesById: entries }),
            member({ machineId: 'machine-b', generation: 2, entriesById: entries }),
        ], new Map());
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toBeNull();
        expect(placement?.hostSupplies).toHaveLength(2);
    });

    it('does not coalesce the same version with different content or renderer ABI', () => {
        const entries = { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes', container: 'appPage' }) };
        const a = member({ machineId: 'machine-a', generation: 1, entriesById: entries });
        const differingContent = member({ machineId: 'machine-b', generation: 2, entriesById: entries,
            archiveDigest: `sha256:${'b'.repeat(64)}` });
        const differingAbi = member({ machineId: 'machine-b', generation: 2, entriesById: entries,
            uiArtifacts: [{ contributionId: 'notes', artifactId: 'notes-web', tier: 'hostedWeb', platform: 'web',
                artifactDigest: `sha256:${'c'.repeat(64)}`, hostUiApiRange: '^2.0.0' }] });
        for (const b of [differingContent, differingAbi]) {
            const placement = unionPluginUiProjections([a, b]).pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
            expect(placement).toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'resolving' } });
            expect(readPluginUiContributionOrigin(placement)).toBeNull();
            expect(readPluginUiProjectionEntryExecutionOrigin(placement)).toBeNull();
        }
    });

    it('retains visible declarations when a saved execution target is offline', () => {
        const sources = [
            member({ machineId: 'machine-a', generation: 1, phase: 'retainedOffline', interactionEnabled: false,
                entriesById: { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes' }) } }),
        ];
        const origin = selectedOrigin('acme.notes', 'machine-a');
        const union = unionPluginUiProjections(sources, selectedOrigins(origin));
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toMatchObject({ phase: 'retainedOffline', interactionEnabled: false,
            machineId: 'machine-a', executionOrigin: origin });
        // 2026-10-16 owner ruling: visible supply alone never elects Run on.
        const unselected = unionPluginUiProjections(sources, new Map()).pluginUiProjection
            ?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(unselected).toBeDefined();
        expect(readPluginUiContributionOrigin(unselected)).toBeNull();
        expect(readPluginUiContributionSupplies(unselected)).toMatchObject([
            { phase: 'retainedOffline', interactionEnabled: false, executionOrigin: origin },
        ]);
    });

    it('does not let retained offline or establishing versions conflict with a current selectable supply', () => {
        const pluginId = 'acme.notes';
        const entries = { panel: placementEntry({ pluginId, localId: 'notes', container: 'appPage' }) };
        const current = member({ machineId: 'machine-z', generation: 2, entriesById: entries });
        for (const phase of ['retainedOffline', 'establishing'] as const) {
            const retained = member({ machineId: 'machine-a', generation: 1, entriesById: { ...entries,
                old: placementEntry({ pluginId, localId: 'old-page', container: 'appPage' }) },
                phase, interactionEnabled: false, archiveDigest: `sha256:${'b'.repeat(64)}` });
            const union = unionPluginUiProjections([retained, current]);
            const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
            expect(placement).toMatchObject({ hostCompatibility: 'compatible', availability: { state: 'available' } });
            expect(placement?.hostSupplies).toHaveLength(2);
            expect(readPluginUiContributionOrigin(placement)).toBeNull();
            const selected = unionPluginUiProjections([retained, current], selectedOrigins(selectedOrigin(pluginId, 'machine-z')));
            expect(readPluginUiContributionOrigin(selected.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes']))
                .toMatchObject({ machineId: 'machine-z', interactionEnabled: true });
            expect(selected.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:old-page']).toBeUndefined();
        }
    });

    it('keeps an unresolved execution choice loading while retaining genuine selectable content conflicts', () => {
        const entries = { panel: placementEntry({ pluginId: 'acme.notes', localId: 'notes', container: 'appPage' }) };
        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 1, entriesById: entries }),
            member({ machineId: 'machine-b', generation: 2, entriesById: entries, archiveDigest: `sha256:${'b'.repeat(64)}` }),
        ]);
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'resolving' } });
        expect(readPluginUiContributionOrigin(placement)).toBeNull();
    });

    it('does not count a current projection whose exact supply Administration rejects as selectable', () => {
        const pluginId = 'acme.notes';
        const entries = { panel: placementEntry({ pluginId, localId: 'notes', container: 'appPage' }) };
        const current = { ...member({ machineId: 'machine-z', generation: 2, entriesById: entries }),
            selectableExecutionOrigins: [selectedOrigin(pluginId, 'machine-z')] };
        const rejected = { ...member({ machineId: 'machine-a', generation: 1, entriesById: entries,
            archiveDigest: `sha256:${'b'.repeat(64)}` }), selectableExecutionOrigins: [] };
        const union = unionPluginUiProjections([rejected, current]);
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'])
            .toMatchObject({ hostCompatibility: 'compatible' });
    });

    it('lists divergent installed versions as a conflict instead of hiding or selecting one', () => {
        const pluginId = 'acme.notes';
        const replica = (machineId: string, version: string) => member({ machineId, generation: 1,
            entriesById: { panel: placementEntry({ pluginId, localId: 'notes', container: 'appPage' }) },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Notes', version, enabled: true,
                source: { kind: 'marketplace', locator: pluginId } } },
        });
        const union = unionPluginUiProjections([replica('machine-a', '1.0.0'), replica('machine-b', '2.0.0')], new Map());
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.notes:notes'];
        expect(placement).toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'resolving' } });
        expect(placement?.hostSupplies).toHaveLength(2);
        expect(readPluginUiContributionOrigin(placement)).toBeNull();
    });

    it('handles absent optional execution origins without allocating schema errors', () => {
        const source = { machineId: 'machine-a', serverId: 'server-1', phase: 'current', interactionEnabled: true,
            projection: machineProjection({ generation: 1, entriesById: {
                placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            } }) } as const;
        // Call-through instrumentation: all present/invalid records still use the real schema.
        const parse = vi.spyOn(PluginMachineExecutionOriginV1Schema, 'safeParse');
        try {
            const union = unionPluginUiProjections([source], new Map());
            const placement = Object.values(union.pluginUiProjection?.surfacePlacementsById ?? {})[0];
            expect(placement).toBeDefined();
            expect(readPluginUiContributionOrigin(placement)).toBeNull();
            expect(readPluginUiContributionSupplies(placement)).toMatchObject([
                { machineId: 'machine-a', executionOrigin: null },
            ]);
            expect(parse).not.toHaveBeenCalled();
        } finally {
            parse.mockRestore();
        }
        expect(readPluginUiProjectionEntryExecutionOrigin({ pluginId: 'acme.inspector', serverIdentityId: 'srv_test',
            materializationRef: { pluginId: 'acme.inspector' } })).toBeNull();
        expect(readPluginUiContributionOrigin({ hostOrigin: { machineId: 'machine-a', phase: 'current',
            executionOrigin: { serverIdentityId: 'srv_test', materializationRef: {} } } })?.executionOrigin).toBeNull();
        const valid = selectedOrigin('acme.inspector', 'machine-a');
        expect(readPluginUiProjectionEntryExecutionOrigin({ pluginId: 'acme.inspector', executionOrigin: valid })).toEqual(valid);
    });

    it.runIf(process.env.HAPPIER_MEASURE_UI_HOT_LOOPS === '1')('measures 2,000 originless contributions', () => {
        const source = { machineId: 'machine-a', serverId: 'server-1', phase: 'current', interactionEnabled: true,
            projection: machineProjection({ generation: 1, entriesById: Object.fromEntries(
                Array.from({ length: 2_000 }, (_, index) => [`placement-${index}`,
                    placementEntry({ pluginId: 'acme.inspector', localId: `panel-${index}` })]),
            ) }) } as const;
        const start = performance.now();
        for (let index = 0; index < 5; index++) {
            const union = unionPluginUiProjections([source], new Map());
            expect(Object.keys(union.pluginUiProjection?.surfacePlacementsById ?? {})).toHaveLength(2_000);
        }
        console.log(JSON.stringify({ measurement: 'originless-projection', contributions: 2_000, unions: 5,
            elapsedMs: performance.now() - start }));
    });

    it('retains a schema-only input type from its selected serving occurrence without a UI sibling', () => {
        const pluginId = 'acme.types';
        const origin = selectedOrigin(pluginId, 'machine-a');
        const type = { id: `${pluginId}/repository`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'current',
            definition: { id: 'repository', title: 'Repository', semantic: 'repository', valueSchema: { type: 'string' as const } },
            executionOrigin: origin };
        const projection = machineProjection({ generation: 3, entriesById: {},
            inputTypesById: { [type.id]: type }, installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Types', version: '1.0.0', enabled: true,
                    occurrenceId: 'current', source: { kind: 'bundled', locator: pluginId } },
            } });
        const source = { machineId: 'machine-a', serverId: 'server-1', projection,
            phase: 'current', interactionEnabled: true } as const;
        const admitted = unionPluginUiProjections([source], selectedOrigins(origin)).pluginUiProjection?.inputTypesById[type.id];
        expect(admitted).toMatchObject({ occurrenceId: 'current', definition: type.definition });
        expect(readPluginUiContributionOrigin(admitted)).toMatchObject({ executionOrigin: origin, machineId: 'machine-a' });
        const refreshing = unionPluginUiProjections([
            { ...source, phase: 'establishing', interactionEnabled: false },
            { machineId: 'machine-b', serverId: 'server-1', projection: machineProjection({ generation: 1, entriesById: {} }),
                phase: 'current', interactionEnabled: true },
        ], new Map());
        expect(refreshing.phase).toBe('current');
        const pendingType = refreshing.pluginUiProjection?.inputTypesById[type.id];
        expect(pendingType).toMatchObject({ occurrenceId: 'current', definition: type.definition });
        expect(pendingType?.executionOrigin).toBeUndefined();
        expect(readPluginUiContributionOrigin(pendingType)).toBeNull();
        expect(readPluginUiContributionSupplies(pendingType)).toMatchObject([
            { machineId: 'machine-a', occurrenceId: 'current', phase: 'establishing', interactionEnabled: false },
        ]);
        const offline = unionPluginUiProjections([{ ...source, phase: 'retainedOffline', interactionEnabled: false }], new Map());
        expect(offline.interactionEnabled).toBe(false);
        const offlineType = offline.pluginUiProjection?.inputTypesById[type.id];
        expect(offlineType).toMatchObject({ occurrenceId: 'current', definition: type.definition });
        expect(offlineType?.executionOrigin).toBeUndefined();
        expect(readPluginUiContributionOrigin(offlineType)).toBeNull();
        expect(unionPluginUiProjections([source], selectedOrigins({ ...origin,
            materializationRef: { ...origin.materializationRef, materializationId: 'another-materialization' },
        })).pluginUiProjection?.inputTypesById[type.id]).toBeUndefined();
        const retired = { ...projection, inputTypesById: { [type.id]: { ...type, occurrenceId: 'retired' } } };
        expect(unionPluginUiProjections([{ ...source, projection: retired }], selectedOrigins(origin))
            .pluginUiProjection?.inputTypesById[type.id]).toBeUndefined();
        const originless = { ...projection, inputTypesById: { [type.id]: { ...type,
            executionOrigin: undefined } } };
        const unselected = unionPluginUiProjections([{ ...source, projection: originless }], new Map())
            .pluginUiProjection?.inputTypesById[type.id];
        expect(unselected).toMatchObject({ definition: type.definition });
        expect(unselected?.occurrenceId).toBe('current');
        expect(readPluginUiContributionOrigin(unselected)).toBeNull();
        expect(readPluginUiContributionSupplies(unselected)).toMatchObject([
            { machineId: 'machine-a', occurrenceId: 'current', executionOrigin: null },
        ]);
    });
    it('admits a Resource-only plugin from its exact selected producer origin and current occurrence', () => {
        const pluginId = 'acme.data';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const resource = (machineId: string, occurrenceId: string) => ({
            id: 'report', pluginId, resourceKind: 'config', scope: 'global',
            contentType: 'application/json', digest: null, occurrenceId,
            executionOrigin: selectedOrigin(pluginId, machineId),
        });
        const source = (machineId: string, occurrenceId: string, resourceOccurrenceId = occurrenceId) => member({
            machineId, generation: machineId === 'machine-a' ? 3 : 99,
            resourcesById: { [`${pluginId}/report`]: resource(machineId, resourceOccurrenceId) },
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Data', version: '1.0.0',
                enabled: true, occurrenceId, source: { kind: 'bundled', locator: pluginId } } },
        });
        const union = unionPluginUiProjections([source('machine-b', 'b'), source('machine-a', 'a')], selectedOrigins(selected));
        const admitted = union.pluginUiProjection?.resourcesById[`${pluginId}/report`];
        expect(admitted).toMatchObject({ occurrenceId: 'a' });
        expect(readPluginUiContributionOrigin(admitted)).toMatchObject({ machineId: 'machine-a', executionOrigin: selected });
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]).toMatchObject({ occurrenceId: 'a' });
        expect(union.pluginUiProjection?.surfacePlacementsById).toEqual({});
        expect(unionPluginUiProjections([source('machine-b', 'b')], selectedOrigins(selected)).pluginUiProjection).toBeNull();
        expect(unionPluginUiProjections([source('machine-a', 'a', 'retired')], selectedOrigins(selected)).pluginUiProjection).toBeNull();
        expect(unionPluginUiProjections([source('machine-a', 'a')], new Map()).pluginUiProjection).toBeNull();
    });
    it('retains Composer-only declarations and their supplies without electing an execution origin', () => {
        const selected = selectedOrigin('acme.inspector', 'machine-a');
        const sources = [composerMember('machine-b'), composerMember('machine-a')];
        const declarations = unionPluginUiProjections(sources, new Map()).pluginUiProjection;
        const control = declarations?.composerControlsById['acme.inspector/inspect'];
        expect(control).toMatchObject({ definition: { label: 'Inspect' } });
        expect(control?.occurrenceId).toBeUndefined();
        expect(readPluginUiContributionOrigin(control)).toBeNull();
        expect(readPluginUiContributionSupplies(control)).toMatchObject([
            { machineId: 'machine-a', occurrenceId: 'machine-a:composer' },
            { machineId: 'machine-b', occurrenceId: 'machine-b:composer' },
        ]);
        const union = unionPluginUiProjections(sources, selectedOrigins(selected));
        expect(union.machineId).toBeNull();
        expect(union.pluginUiProjection?.composerControlsById['acme.inspector/inspect'])
            .toMatchObject({ occurrenceId: 'machine-a:composer' });
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.composerRegionsById['acme.inspector/summary']))
            .toMatchObject({ machineId: 'machine-a', executionOrigin: selected, interactionEnabled: true });
        const offline = unionPluginUiProjections([{ ...sources[1]!, phase: 'retainedOffline', interactionEnabled: false }], selectedOrigins(selected));
        expect(readPluginUiContributionOrigin(offline.pluginUiProjection?.composerControlsById['acme.inspector/inspect']))
            .toMatchObject({ machineId: 'machine-a', interactionEnabled: false, phase: 'retainedOffline' });
        expect(union.pluginUiProjection?.composerAttachmentsById).toEqual({});
    });

    it('uses Administration selection for conflicting Composer declarations and preserves installed declarations', () => {
        const sources = [composerMember('machine-a'), composerMember('machine-b', 'Review')];
        const conflict = unionPluginUiProjections(sources, new Map()).pluginUiProjection?.composerControlsById['acme.inspector/inspect'];
        expect(readPluginUiContributionOrigin(conflict)).toBeNull();
        expect(conflict).toMatchObject({ hostCompatibility: 'conflict' });
        const selected = selectedOrigin('acme.inspector', 'machine-b');
        const union = unionPluginUiProjections(sources, selectedOrigins(selected));
        expect(union.pluginUiProjection?.composerControlsById['acme.inspector/inspect'])
            .toMatchObject({ definition: { label: 'Review' }, occurrenceId: 'machine-b:composer' });
        expect(readPluginUiContributionSupplies(union.pluginUiProjection?.composerControlsById['acme.inspector/inspect']))
            .toHaveLength(2);
        const installed = sources[0]!.projection;
        if (!installed) throw new Error('fixture must produce a projection');
        const cold = mergeInstalledPluginUiProjections([installed], null);
        expect(cold?.composerControlsById['acme.inspector/inspect']).toEqual(installed.composerControlsById['acme.inspector/inspect']);
        expect(cold?.composerRegionsById['acme.inspector/summary']).toEqual(installed.composerRegionsById['acme.inspector/summary']);
    });

    it('retains Resources only from the same selected member as the plugin contribution', () => {
        const selected = selectedOrigin('acme.inspector', 'machine-a');
        const source = member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: {
                placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            },
        });
        if (!source.projection) throw new Error('fixture must produce a projection');

        const resource = PluginProjectedResourceV2Schema.parse({
            id: 'report', pluginId: 'acme.inspector', resourceKind: 'asset' as const,
            scope: 'global' as const, contentType: 'application/json',
        });
        const union = unionPluginUiProjections([{
            ...source,
            projection: {
                ...source.projection,
                resourcesById: {
                    'acme.inspector/report': resource,
                },
            },
        }, member({
            machineId: 'machine-b', generation: 99,
            entriesById: { placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }) },
            resourcesById: { 'acme.inspector/report': { ...resource, scope: 'session' } },
        })], selectedOrigins(selected));

        expect(union.pluginUiProjection?.resourcesById['acme.inspector/report']).toMatchObject(resource);
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.resourcesById['acme.inspector/report']))
            .toMatchObject({ machineId: 'machine-a', executionOrigin: selected });
        expect(Object.isFrozen(union.pluginUiProjection?.resourcesById)).toBe(true);
        expect(union.pluginUiProjection?.surfacePlacementsById).not.toEqual({});
        const unavailableChoice = unionPluginUiProjections([source], selectedOrigins(selectedOrigin('acme.inspector', 'machine-b')));
        expect(unavailableChoice.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(unavailableChoice.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
        const originless = machineProjection({ generation: 4,
            entriesById: { placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }) },
            resourcesById: { 'acme.inspector/report': resource },
        });
        const originlessUnion = unionPluginUiProjections([{ ...source, projection: originless }], new Map());
        expect(originlessUnion.pluginUiProjection?.resourcesById['acme.inspector/report']).toMatchObject(resource);
        expect(readPluginUiContributionOrigin(originlessUnion.pluginUiProjection?.resourcesById['acme.inspector/report']))
            .toBeNull();
        expect(readPluginUiContributionSupplies(originlessUnion.pluginUiProjection?.resourcesById['acme.inspector/report']))
            .toMatchObject([{ machineId: 'machine-a', executionOrigin: null }]);
    });

    it('uses the exact selected installation despite another installation having different content', () => {
        const pluginId = 'acme.inspector';
        const entries = { placement: placementEntry({ pluginId, localId: 'panel' }) };
        const replicas = ['machine-a', 'machine-b'].map((machineId, index) => member({
            machineId, generation: 3, entriesById: entries,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Inspector', version: String(index),
                enabled: true, source: { kind: 'bundled', locator: pluginId }, occurrenceId: machineId } },
        }));
        const union = unionPluginUiProjections(replicas, selectedOrigins(selectedOrigin(pluginId, 'machine-a')));
        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'];
        expect(placement).toMatchObject({ hostCompatibility: 'compatible', availability: { state: 'available' } });
        expect(readPluginUiContributionOrigin(placement)).toMatchObject({ machineId: 'machine-a' });
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]?.occurrenceId).toBe('machine-a');
        expect(union.pluginUiProjection?.installedPackagesById[pluginId]?.enabled).toBe(true);
        const origin = selectedOrigin(pluginId, 'machine-a');
        const replaced = unionPluginUiProjections(replicas, selectedOrigins({ ...origin,
            materializationRef: { ...origin.materializationRef, materializationId: 'replaced' },
        })).pluginUiProjection;
        expect(replaced?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])
            .toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'resolving' } });
        expect(readPluginUiContributionOrigin(replaced?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
    });

    it('keeps nonidentical replicated declarations as a visible conflict before selection', () => {
        const replicaEntries = {
            placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
        };

        const union = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 3, entriesById: replicaEntries }),
            // This replica deliberately contains more entries. The app shell
            // must not turn that into an implicit election.
            member({
                machineId: 'machine-b',
                generation: 4,
                entriesById: {
                    ...replicaEntries,
                    extra: placementEntry({ pluginId: 'acme.inspector', localId: 'extra' }),
                },
            }),
        ], new Map());

        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])
            .toMatchObject({ hostCompatibility: 'conflict', availability: { state: 'resolving' } });
    });

    it('retains a same-machine declaration without binding a replaced materialization', () => {
        const pluginId = 'acme.inspector';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const staleSameMachine: PluginMachineExecutionOriginV1 = {
            ...selected,
            materializationRef: {
                ...selected.materializationRef,
                materializationId: 'machine-a:acme.inspector:stale-install',
            },
        };

        const union = unionPluginUiProjections([member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: { placement: placementEntry({ pluginId, localId: 'panel' }) },
            producerOriginsByPluginId: { [pluginId]: staleSameMachine },
        })], selectedOrigins(selected));

        // A machine id match alone used to admit this entry. The direct V2
        // producer stamp has a different install/materialization identity, so
        // its page/panel must be unavailable rather than silently elected.
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
    });

    it('retains a declaration without binding a foreign server identity', () => {
        const pluginId = 'acme.inspector';
        const selected = selectedOrigin(pluginId, 'machine-a');
        const foreignServer = {
            ...selected,
            serverIdentityId: 'srv_other',
        } satisfies PluginMachineExecutionOriginV1;

        const union = unionPluginUiProjections([member({
            machineId: 'machine-a',
            generation: 3,
            entriesById: { placement: placementEntry({ pluginId, localId: 'panel' }) },
            producerOriginsByPluginId: { [pluginId]: foreignServer },
        })], selectedOrigins(selected));

        // The materialization key is scoped by server identity. Keeping the
        // same machine/plugin/install coordinates is still not enough to make
        // bytes from another server a selected App contribution.
        expect(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel']).toBeDefined();
        expect(readPluginUiContributionOrigin(union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'])).toBeNull();
    });

    it('keeps every machine\'s contributions and stamps each with its own origin', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-b',
                generation: 4,
                entriesById: { b: placementEntry({ pluginId: 'acme.beta', localId: 'panel' }) },
                interactionEnabled: false,
            }),
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
            }),
        ], selectedOrigins(
            selectedOrigin('acme.alpha', 'machine-a'),
            selectedOrigin('acme.beta', 'machine-b'),
        ));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements.map((entry) => entry.id)).toEqual([
            'surfacePlacement:acme.alpha:panel',
            'surfacePlacement:acme.beta:panel',
        ]);
        expect(readPluginUiContributionOrigin(placements[0])).toEqual({
            machineId: 'machine-a',
            serverId: 'server-1',
            interactionEnabled: true,
            phase: 'current',
            executionOrigin: selectedOrigin('acme.alpha', 'machine-a'),
        });
        // Executable authority is per origin: machine-b's stale projection does
        // not inherit machine-a's currentness.
        expect(readPluginUiContributionOrigin(placements[1])).toEqual({
            machineId: 'machine-b',
            serverId: 'server-1',
            interactionEnabled: false,
            phase: 'retainedOffline',
            executionOrigin: selectedOrigin('acme.beta', 'machine-b'),
        });
        // Several members means there is no single app machine, and none is invented.
        expect(union.machineId).toBeNull();
    });

    it('projects the selected producer as a whole instead of mixing in another replica\'s entries', () => {
        const replicaEntries = {
            placement: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
            reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
        };
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-z',
                generation: 99,
                entriesById: {
                    ...replicaEntries,
                    extra: placementEntry({ pluginId: 'acme.inspector', localId: 'extra' }),
                },
            }),
            member({ machineId: 'machine-a', generation: 2, entriesById: replicaEntries }),
        ], selectedOrigins(selectedOrigin('acme.inspector', 'machine-a')));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements).toHaveLength(1);
        expect(placements[0]?.hostCompatibility).toBe('compatible');
        expect(readPluginUiContributionOrigin(placements[0])).toMatchObject({ machineId: 'machine-a' });

    });

    it('carries a client Action only from its exact selected producer and preserves its execution target', () => {
        const pluginId = 'acme.client-action';
        const actionId = `${pluginId}/open-preview`;
        const outputSchema = {
            type: 'object',
            properties: {
                summary: { type: 'string' },
            },
            required: ['summary'],
            additionalProperties: false,
        } as const;
        const action = {
            id: 'open-preview',
            pluginId,
            title: 'Open preview',
            scopes: ['session'],
            surfaces: ['ui'],
            placementBindings: ['detailsPanel'],
            dangerLevel: 'safe',
            available: true,
            execution: {
                target: 'client',
                client: {
                    artifactId: 'client-runtime',
                    exportName: 'activate',
                },
                platforms: ['web'],
            },
            outputSchema,
        };
        const selected = selectedOrigin(pluginId, 'machine-a');

        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-b',
                generation: 4,
                actionsById: { [actionId]: action },
            }),
            member({
                machineId: 'machine-a',
                generation: 3,
                actionsById: { [actionId]: action },
            }),
        ], selectedOrigins(selected));

        const projected = union.pluginUiProjection?.actionsById[actionId];
        expect(projected).toMatchObject({
            ...action,
            execution: action.execution,
            outputSchema,
        });
        expect(readPluginUiContributionOrigin(projected)).toEqual({
            machineId: 'machine-a',
            serverId: 'server-1',
            interactionEnabled: true,
            phase: 'current',
            executionOrigin: selected,
        });
    });

    it('does not let an older replica of a plugin hide the machine that actually has its app surface', () => {
        const union = unionPluginUiProjections([
            // machine-a sorts first, but its copy of the plugin predates the
            // `app.rightSidebarTab` contribution entirely.
            member({
                machineId: 'machine-a',
                generation: 8,
                entriesById: {
                    session: placementEntry({
                        pluginId: 'acme.inspector',
                        localId: 'session',
                        container: 'rightSidebarTab',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                    }),
                },
            }),
            member({
                machineId: 'machine-b',
                generation: 9,
                entriesById: {
                    session: placementEntry({
                        pluginId: 'acme.inspector',
                        localId: 'session',
                        container: 'rightSidebarTab',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                    }),
                    app: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
                    reactNativeBundle: reactNativeBundleEntry('acme.inspector'),
                },
            }),
        ], selectedOrigins(selectedOrigin('acme.inspector', 'machine-b')));

        const placements = union.pluginUiProjection
            ? selectPluginSurfacePlacementsForBinding(union.pluginUiProjection, {
                container: 'rightSidebarTab',
                targetKind: 'app',
            })
            : [];
        expect(placements.map((entry) => entry.id)).toEqual(['surfacePlacement:acme.inspector:panel']);
        expect(placements[0]?.hostCompatibility).toBe('compatible');
        expect(readPluginUiContributionOrigin(placements[0])).toMatchObject({ machineId: 'machine-b' });

    });

    it('publishes the sole member\'s machine and generation unchanged', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-only',
                generation: 11,
                entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
            }),
        ], selectedOrigins(selectedOrigin('acme.alpha', 'machine-only')));
        expect(union.machineId).toBe('machine-only');
        expect(union.serverId).toBe('server-1');
        expect(union.pluginUiProjection?.generation).toBe(11);
    });

    it('keeps publication identity across unrelated member generations and publishes an edited declaration', () => {
        const publication = projectionUnion.createPluginUiProjectionUnionPublication();
        const alphaEntry = placementEntry({ pluginId: 'acme.alpha', localId: 'panel' });
        const betaEntry = placementEntry({ pluginId: 'acme.beta', localId: 'panel' });
        const alpha = member({ machineId: 'machine-a', generation: 3, entriesById: { [alphaEntry.id]: alphaEntry } });
        const beta = member({ machineId: 'machine-b', generation: 4, entriesById: { [betaEntry.id]: betaEntry } });
        const origins = selectedOrigins(
            selectedOrigin('acme.alpha', 'machine-a'),
            selectedOrigin('acme.beta', 'machine-b'),
        );
        const first = publication.publish([alpha, beta], origins).pluginUiProjection;
        expect(publication.publish([alpha, { ...beta, projection: { ...beta.projection!, generation: 5 } }], origins).pluginUiProjection).toBe(first);
        const changed = { ...beta, projection: { ...beta.projection!, surfacePlacementsById: {
            ...beta.projection!.surfacePlacementsById,
            [betaEntry.id]: { ...beta.projection!.surfacePlacementsById[betaEntry.id]!, display: {
                ...beta.projection!.surfacePlacementsById[betaEntry.id]!.display, title: 'Edited beta panel',
            } },
        } } };
        const updated = publication.publish([alpha, changed], origins).pluginUiProjection;
        expect(updated).not.toBe(first);
        expect(updated?.surfacePlacementsById[betaEntry.id]?.display.title).toBe('Edited beta panel');
    });

    it('reports a current empty catalog only after members have settled their describes', () => {
        const settledEmpty = unionPluginUiProjections([
            member({ machineId: 'machine-a', generation: 3 }),
        ], new Map());
        expect(settledEmpty.pluginUiProjection).toBeNull();
        expect(settledEmpty.phase).toBe('current');
        expect(unionPluginUiProjections([
            {
                machineId: 'machine-a',
                serverId: 'server-1',
                projection: EMPTY_PLUGIN_UI_PROJECTION,
                phase: 'retainedOffline',
                interactionEnabled: false,
            },
            {
                machineId: 'machine-b',
                serverId: 'server-1',
                projection: EMPTY_PLUGIN_UI_PROJECTION,
                phase: 'retainedOffline',
                interactionEnabled: false,
            },
        ], new Map()).pluginUiProjection).toBeNull();
    });

    it('keeps an absent first description explicitly establishing instead of turning it into a tombstone', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            }),
        ], new Map());

        expect(union).toMatchObject({
            pluginUiProjection: null,
            phase: 'establishing',
            interactionEnabled: false,
            machineId: 'machine-a',
        });
    });

    it('keeps a selected origin pending while its first describe is establishing despite an unrelated current member', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: {
                    unrelated: placementEntry({ pluginId: 'acme.unrelated', localId: 'panel' }),
                },
            }),
            member({
                machineId: 'machine-b',
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            }),
        ], selectedOrigins(selectedOrigin('acme.pending', 'machine-b')));

        // `machine-a` cannot prove that `acme.pending` is absent from the
        // selected machine. A restored page for that plugin must remain
        // unresolved until machine-b's first describe settles.
        expect(union).toMatchObject({
            phase: 'current',
            hasEstablishingMembers: true,
            interactionEnabled: true,
        });
    });

    it('keeps an admitted current contribution usable while forty unrelated members are establishing', () => {
        const union = unionPluginUiProjections([
            member({
                machineId: 'machine-a',
                generation: 3,
                entriesById: {
                    selected: placementEntry({ pluginId: 'acme.selected', localId: 'panel' }),
                },
            }),
            ...Array.from({ length: 40 }, (_, index) => member({
                machineId: `offline-${index}`,
                generation: undefined,
                phase: 'establishing',
                interactionEnabled: false,
            })),
        ], selectedOrigins(selectedOrigin('acme.selected', 'machine-a')));

        // The admitted contribution owns its readiness. An offline Machine
        // with no current description cannot withhold that origin's catalog.
        expect(union).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
        });
        expect(readPluginUiContributionOrigin(
            union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.selected:panel'],
        )).toMatchObject({
            phase: 'current',
            interactionEnabled: true,
        });
    });

    it('admits an unmaterialized contribution by structure, for a bundled and an external plugin alike', () => {
        // The producer stamps an entry only when it knows a materialization for
        // that plugin. A plugin the Account can never materialize — one shipped
        // inside the host binary, and equally an externally authored plugin the
        // daemon loaded from a source root — therefore has nothing to stamp and
        // nothing for Administration to select. Requiring a selected origin
        // there is fail-always, not fail-closed, and the discriminator is the
        // missing stamp, never the plugin's provenance.
        const installedPackage = (pluginId: string, kind: string) => ({
            id: pluginId,
            displayName: pluginId,
            version: '1.0.0',
            enabled: true,
            source: { kind, locator: pluginId },
        });
        const unstampedMember: PluginUiProjectionUnionMember = {
            machineId: 'machine-a',
            serverId: 'server-1',
            projection: machineProjection({
                generation: 7,
                entriesById: {
                    bundled: placementEntry({
                        pluginId: 'happier.triage',
                        localId: 'triage',
                        container: 'appPage',
                    }),
                    external: placementEntry({ pluginId: 'acme.inspector', localId: 'panel' }),
                },
                installedPackagesById: {
                    'happier.triage': installedPackage('happier.triage', 'bundled'),
                    'acme.inspector': installedPackage('acme.inspector', 'marketplace'),
                },
            }),
            phase: 'current',
            interactionEnabled: true,
        };

        const union = unionPluginUiProjections([unstampedMember], new Map());

        const bundled = union.pluginUiProjection
            ?.surfacePlacementsById['surfacePlacement:happier.triage:triage'];
        const external = union.pluginUiProjection
            ?.surfacePlacementsById['surfacePlacement:acme.inspector:panel'];
        expect(bundled).toBeDefined();
        // C1: the external plugin in the identical structural position is
        // admitted on identical terms. A `source.kind` branch here would give
        // the bundled copy a capability the external one cannot reach.
        expect(external).toBeDefined();
        expect(union.pluginUiProjection?.installedPackagesById['happier.triage']).toBeDefined();
        expect(union.pluginUiProjection?.installedPackagesById['acme.inspector']).toBeDefined();
        expect(union.interactionEnabled).toBe(true);
        // 2026-10-16 owner ruling: these are descriptive supplies, not an
        // implicit Machine binding. Exact-origin consumers remain fail-closed.
        for (const admitted of [bundled, external]) {
            expect(readPluginUiContributionOrigin(admitted)).toBeNull();
            expect(admitted?.occurrenceId).toBeUndefined();
            expect(readPluginUiContributionSupplies(admitted)).toMatchObject([{
                machineId: 'machine-a',
                phase: 'current',
                executionOrigin: null,
            }]);
        }
    });

    it('retains an unstamped declaration without granting the selected materialization authority', () => {
        // The fail-closed half that must survive the re-key: once the Account
        // holds a selection for a plugin id, only the exact producer stamp
        // admits it. A daemon that lost its execution-origin context publishes
        // unstamped entries, and those must not slip in through the
        // unmaterialized arm.
        const unstampedMember: PluginUiProjectionUnionMember = {
            machineId: 'machine-a',
            serverId: 'server-1',
            projection: machineProjection({
                generation: 7,
                entriesById: {
                    selected: placementEntry({ pluginId: 'acme.selected', localId: 'panel' }),
                },
                installedPackagesById: {},
            }),
            phase: 'current',
            interactionEnabled: true,
        };

        const union = unionPluginUiProjections(
            [unstampedMember],
            selectedOrigins(selectedOrigin('acme.selected', 'machine-a')),
        );

        const placement = union.pluginUiProjection?.surfacePlacementsById['surfacePlacement:acme.selected:panel'];
        expect(placement).toBeDefined();
        expect(readPluginUiContributionOrigin(placement)).toBeNull();

    });

    it('treats an authority flip as a member change and an unchanged snapshot as none', () => {
        const alpha = member({ machineId: 'machine-a', generation: 3,
            entriesById: { panel: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) } });
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha }])).toBe(true);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha,
            selectableExecutionOrigins: [selectedOrigin('acme.alpha', 'machine-a')] }])).toBe(true);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha,
            selectableExecutionOrigins: [] }])).toBe(false);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [{ ...alpha, interactionEnabled: false }])).toBe(false);
        expect(arePluginUiProjectionUnionMembersEquivalent(
            [alpha],
            [{ ...alpha, projection: machineProjection({ generation: 3, entriesById: {} }) }],
        )).toBe(false);
        expect(arePluginUiProjectionUnionMembersEquivalent([alpha], [])).toBe(false);
    });

    it('reads no origin from a single-machine projection entry', () => {
        const scoped = machineProjection({
            generation: 5,
            entriesById: { a: placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }) },
        });
        expect(readPluginUiContributionOrigin(
            scoped.surfacePlacementsById['surfacePlacement:acme.alpha:panel'],
        )).toBeNull();
        expect(readPluginUiContributionOrigin({ hostOrigin: { machineId: '  ' } })).toBeNull();
        expect(readPluginUiContributionOrigin({
            hostOrigin: {
                machineId: 'machine-a',
                interactionEnabled: true,
            },
        })).toBeNull();
        expect(readPluginUiContributionOrigin(null)).toBeNull();
    });

    it('reads only the exact paired producer execution origin from a direct entry', () => {
        const origin = selectedOrigin('acme.alpha', 'machine-a');
        const entry = {
            ...placementEntry({ pluginId: 'acme.alpha', localId: 'panel' }),
            executionOrigin: origin,
        };

        expect(readPluginUiProjectionEntryExecutionOrigin(entry)).toEqual(origin);
        expect(readPluginUiProjectionEntryExecutionOrigin({
            ...entry,
            executionOrigin: { ...origin, materializationRef: { ...origin.materializationRef, pluginId: 'acme.other' } },
        })).toBeNull();
        expect(readPluginUiProjectionEntryExecutionOrigin({
            ...entry,
            executionOrigin: undefined,
        })).toBeNull();
    });
});
