import { ingestPluginManifestV2} from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginProjectedActionV2Schema, PluginProjectionInstalledPackageV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    normalizePluginAccountCollectionContractV1} from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema} from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import {
    createPackageAssetArchiveV1} from '@happier-dev/protocol/plugins/availability/packageAssetV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema} from '@happier-dev/protocol/plugins/availability/v1';
import { derivePluginAccountExecutionArtifactSlots } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/compatibilityProjectionV1';
import { validatePublicPluginManifestPolicy } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { getInstalledPluginUiClientExecutableComposition, type PluginUiClientExecutableActivation } from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import type { PluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';

export type PortableAccountPluginFixture = Readonly<{
    manifest: PluginManifest;
    activate(api: PluginAccountApi): void | Promise<void>;
    prepareRegistration?: PluginUiClientExecutableActivation['prepareRegistration'];
}>;

export type SourceDeclaredAccountPluginFixture = PortableAccountPluginFixture & Readonly<{ packageName: string }>;

/** Prepare physical app declarations before the first Account publication; install after restore. */
export async function prepareSourceDeclaredAccountPluginsForTest(plugins: readonly SourceDeclaredAccountPluginFixture[]) {
    const [{ projectBundledPluginUiDeclaration },
        { installBundledPluginUiDeclarationsForTest }, { getSyncSingleton }, { ensureActivePluginAccountCollectionContract }] = await Promise.all([
        import('../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs'),
        import('../mocks/bundledPluginUiAssets'), import('@/sync/runtime/getSyncSingleton'),
        import('@/sync/api/plugins/availability/ensureActivePluginAccountCollectionContract'),
    ]);
    const declarations = await Promise.all(plugins.map(async plugin => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse(plugin.manifest);
        const target = manifest.contributes.actions.find(action => action.execution.target === 'account')?.execution;
        if (target?.target !== 'account') throw new Error('Fixture requires an authored Account Action');
        return await projectBundledPluginUiDeclaration({ packageName: plugin.packageName,
            packageVersion: manifest.version, manifest, artifactGraphs: [createPortableAccountExecutableArtifact(target.account)] });
    }));
    installBundledPluginUiDeclarationsForTest(declarations);
    return async (input: Readonly<{ accountLifetime: ActiveServerAccountScopeLifetime; publishProjection?: boolean }>) => {
        await getSyncSingleton().refreshPluginAccountAvailability();
        const readAvailability = () => readPluginAccountAvailability(input.accountLifetime.scope);
        for (const declaration of declarations) {
            const ref = declaration.collectionContracts[0];
            if (ref && !await ensureActivePluginAccountCollectionContract({ pluginId: declaration.pluginId, ref,
                accountLifetime: input.accountLifetime, readAvailability })) {
                throw new Error(`Home did not admit authored Account Collections for ${declaration.pluginId}`);
            }
        }
        const projection = readAvailability().readAccountUiProjection();
        if (!projection) throw new Error('Source Account fixture has no admitted projection');
        const prepared: Awaited<ReturnType<typeof preparePortableAccountPluginForTest>>[] = [];
        try {
            for (const plugin of plugins) {
                const selected = readAvailability().readCurrentAccountExecution(plugin.manifest.id);
                if (selected.kind !== 'available') throw new Error(`Source Account fixture is not admitted: ${selected.code}`);
                prepared.push(await preparePortableAccountPluginForTest({ ...plugin, accountLifetime: input.accountLifetime,
                    deferActivation: true, projection, origin: { ...input.accountLifetime.scope,
                        custodyId: selected.custodyId, sourceCustody: selected.sourceCustody } }));
            }
            const activations = prepared.flatMap(plugin => plugin.activations);
            const attempts = await getInstalledPluginUiClientExecutableComposition().reconcile(activations);
            if (attempts.some(attempt => !attempt.result.ok)) {
                throw new Error(`Account fixture activation failed: ${JSON.stringify(attempts.map(attempt => attempt.result))}`);
            }
            const unpublish = publishPortableAccountPluginProjection(projection, input.accountLifetime, input.publishProjection);
            return { projection, activations, async dispose() {
                unpublish();
                for (const plugin of prepared) await plugin.dispose();
            } };
        } catch (error) {
            for (const plugin of prepared) await plugin.dispose();
            throw error;
        }
    };
}

/** Admit a real portable release before installing its Account executable at the byte-loader boundary. */
export async function installPortableAccountPluginReleaseForTest(
    input: PortableAccountPluginFixture & Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        publishProjection?: boolean;
        additionalPlugins?: readonly PortableAccountPluginFixture[];
    }>,
) {
    const installed = await installPortableAccountPluginReleasesForTest({ plugins: [input, ...(input.additionalPlugins ?? [])],
        accountLifetime: input.accountLifetime, publishProjection: input.publishProjection });
    return { ...installed, disable() { return installed.disable(input.manifest.id); } };
}

/** Admit and activate one complete Account plugin set without replacing an earlier plugin's registrations. */
export async function installPortableAccountPluginReleasesForTest(input: Readonly<{
    plugins: readonly PortableAccountPluginFixture[];
    accountLifetime: ActiveServerAccountScopeLifetime;
    publishProjection?: boolean;
}>) {
    const releases = input.plugins.map(plugin => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse(plugin.manifest);
        const accountAction = manifest.contributes.actions.find(action => action.execution.target === 'account');
        if (accountAction?.execution.target !== 'account') throw new Error('Fixture requires an authored Account Action');
        const graph = createPortableAccountExecutableArtifact(accountAction.execution.account);
        const uiSlots = derivePluginAccountExecutionArtifactSlots(manifest.contributes)
            .filter(slot => slot.registrationRight.target.artifactId === graph.artifactId)
            .map(slot => ({ contributionId: slot.contributionId, artifactId: graph.artifactId, tier: graph.tier,
                platform: resolvePluginUiClientExecutablePlatform(), artifactDigest: graph.digest,
                hostUiApiRange: graph.hostUiApiRange, artifactGraph: graph }));
        const contracts = (manifest.contributes.accountCollections ?? []).map(contribution => normalizePluginAccountCollectionContractV1({
            pluginId: manifest.id, contribution: PluginAccountCollectionContributionV1Schema.parse(contribution),
        }));
        // Only descriptors are needed; executable bytes cross the loader boundary below.
        const archive = createPackageAssetArchiveV1({ manifest, files: manifest.contributes.resources.flatMap(resource =>
            resource.kind === 'asset' && 'path' in resource ? [{ path: resource.path, bytes: new TextEncoder().encode('{}') }] : []) });
        if (!archive) throw new Error('Missing portable package asset fixture');
        const refs = contracts.map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({ pluginId, collectionId, schemaVersion, contractDigest }));
        return { plugin, graph, intentRead: { pluginId: manifest.id,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1, packageAssets: [],
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'enabled',
                    writableCollections: refs, revision: 'intent-1' },
                release: { ref: { pluginId: manifest.id, version: manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: refs, uiSlots, packageAssetArchive: archive.descriptor },
                uiArtifacts: [] }) } };
    });
    let intentReads = releases.map(release => release.intentRead);
    const scope = input.accountLifetime.scope;
    let availabilityCursor = 1;
    const availability = () => ({ scope, snapshot: { availabilityCursor, materializations: [], snapshots: [], intentReads } });
    replacePluginAccountAvailabilityProjection(availability());
    const prepared: Awaited<ReturnType<typeof installPortableAccountPluginForTest>>[] = [];
    try {
        for (const { plugin, graph } of releases) {
            const selected = readPluginAccountAvailability(scope).readCurrentAccountExecution(plugin.manifest.id);
            if (selected.kind !== 'available') throw new Error(`Portable Account fixture is not admitted: ${selected.code}`);
            if (selected.sourceCustody.kind !== 'account_release') throw new Error('Expected the admitted portable release custody');
            prepared.push(await preparePortableAccountPluginForTest({ ...plugin, accountLifetime: input.accountLifetime,
                deferActivation: true, origin: { ...scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody } }, graph));
        }
        const activations = prepared.flatMap(plugin => plugin.activations);
        const attempts = await getInstalledPluginUiClientExecutableComposition().reconcile(activations);
        if (attempts.some(attempt => !attempt.result.ok)) {
            throw new Error(`Account fixture activation failed: ${JSON.stringify(attempts.map(attempt => attempt.result))}`);
        }
        const projection = mergeInstalledPluginUiProjections(prepared.map(plugin => plugin.projection), null);
        if (!projection) throw new Error('Portable Account fixture requires at least one plugin');
        const unpublish = publishPortableAccountPluginProjection(projection, input.accountLifetime, input.publishProjection);
        return { projection, activations, async dispose() {
            unpublish();
            for (const plugin of prepared) await plugin.dispose();
        }, disable(pluginId: string) {
            intentReads = intentReads.map(read => read.pluginId === pluginId ? { ...read, response: { ...read.response,
                intent: read.response.intent ? { ...read.response.intent, enabled: false } : null } } : read);
            availabilityCursor += 1;
            replacePluginAccountAvailabilityProjection(availability());
            return readPluginAccountAvailability(scope).readAccountUiProjection();
        } };
    } catch (error) {
        for (const plugin of prepared) await plugin.dispose();
        throw error;
    }
}

function publishPortableAccountPluginProjection(projection: PluginUiProjectionModel,
    accountLifetime: ActiveServerAccountScopeLifetime, publishProjection?: boolean,
): () => void {
    const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
        invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
        reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
    }));
    const unpublish = publishProjection ? publishCommittedAppShellPluginUiProjection(read =>
        accountLifetime.isCurrent() && (!read || read.scope.accountId === accountLifetime.scope.accountId
            && areServerProfileIdentifiersEquivalent(read.scope.serverId, accountLifetime.scope.serverId)) ? projection : null) : undefined;
    return () => { unpublish?.(); unregister(); };
}

/**
 * Install real authored Account activation at the executable-byte loader boundary.
 * Admission, registration, current-context dispatch and invocation services stay real.
 * Install HTTP/Socket boundaries before importing this runtime-bearing harness.
 */
export async function installPortableAccountPluginForTest(input: Parameters<typeof preparePortableAccountPluginForTest>[0]) {
    const prepared = await preparePortableAccountPluginForTest(input);
    const unpublish = publishPortableAccountPluginProjection(prepared.projection, input.accountLifetime, input.publishProjection);
    return { ...prepared, async dispose() { unpublish(); await prepared.dispose(); } };
}

async function preparePortableAccountPluginForTest(input: Readonly<{
    manifest: PluginManifest;
    activate(api: PluginAccountApi): void | Promise<void>;
    prepareRegistration?: PluginUiClientExecutableActivation['prepareRegistration'];
    accountLifetime: ActiveServerAccountScopeLifetime;
    origin?: PluginUiAccountExecutableOrigin;
    /** A source fixture consumes the complete projection admitted by Availability. */
    projection?: PluginUiProjectionModel;
    /** Model the AppShell's scoped publication for ordinary host dependencies. */
    publishProjection?: boolean;
    /** Prepare several actual plugins, then admit their complete activation set together. */
    deferActivation?: boolean;
}>, preparedArtifact?: ReturnType<typeof createPortableAccountExecutableArtifact>) {
    const platform = resolvePluginUiClientExecutablePlatform();
    const parsed = ingestPluginManifestV2(input.manifest);
    if (!parsed.ok) throw new Error(`Invalid authored Account fixture: ${JSON.stringify(parsed.diagnostics)}`);
    const diagnostics = validatePublicPluginManifestPolicy(parsed.manifest);
    if (diagnostics.length > 0) throw new Error(`Invalid authored Account fixture: ${JSON.stringify(diagnostics)}`);
    const actions = parsed.manifest.contributes.actions.filter(action => action.execution.target === 'account');
    const resources = parsed.manifest.contributes.resources.flatMap(resource => resource.source === 'dynamic'
        && resource.execution?.target === 'account' ? [resource] : []);
    const target = actions[0]?.execution;
    if (target?.target !== 'account') throw new Error('Fixture requires an authored Account Action');
    const account = target.account;
    const occurrenceId = input.origin?.custodyId ?? `account-fixture-${input.manifest.id}`;
    const origin = input.origin ?? { ...input.accountLifetime.scope, custodyId: occurrenceId,
        sourceCustody: { kind: 'account_release' as const, pluginId: input.manifest.id, version: input.manifest.version,
            archiveDigestSha256: `sha256:${'a'.repeat(64)}` } };
    const authorization = { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
        resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] };
    const graph = preparedArtifact ?? createPortableAccountExecutableArtifact(account);
    const projectedActions = actions.map(declaration => {
        const { hostAccess: _hostAccess, connectedAccountPurposeBindings: _connectedAccountPurposeBindings,
            inputSchema: _inputSchema, resultSchema: _resultSchema, ...projected } = declaration;
        return { ...PluginProjectedActionV2Schema.parse({ ...projected, pluginId: input.manifest.id,
            occurrenceId, available: true, authorization }), hostAccountOrigin: origin, accountActionDeclaration: declaration };
    });
    const projectedResources = resources.map(declaration => ({ id: declaration.id, pluginId: input.manifest.id,
        occurrenceId, resourceKind: declaration.kind, scope: declaration.scope,
        contentType: declaration.contentType, execution: declaration.execution,
        hostAccountOrigin: origin, accountResourceDeclaration: declaration }));
    const connectedAccountDescriptorsById = Object.fromEntries(Object.entries(
        readPluginAccountAvailability(input.accountLifetime.scope).readAccountUiProjection()?.connectedAccountDescriptorsById ?? {},
    ).filter(([, descriptor]) => descriptor.pluginId === input.manifest.id));
    const contributionIds = [...projectedActions.map(action => action.id), ...projectedResources.map(resource => `resources/${resource.id}`),
        ...Object.values(connectedAccountDescriptorsById).map(descriptor => `connectedAccountDescriptors/${descriptor.id}`)];
    const projection: PluginUiProjectionModel = input.projection ?? {
        ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        installedPackagesById: { [input.manifest.id]: PluginProjectionInstalledPackageV2Schema.parse({
            id: input.manifest.id, displayName: input.manifest.displayName, version: input.manifest.version,
            enabled: true, source: { kind: 'localPath', locator: input.manifest.id },
        }) },
        actionsById: Object.fromEntries(projectedActions.map(action => [`${input.manifest.id}/${action.id}`, action])),
        resourcesById: Object.fromEntries(projectedResources.map(resource => [`${input.manifest.id}/${resource.id}`, resource])),
        connectedAccountDescriptorsById,
        reactNativeBundlesById: Object.fromEntries(contributionIds.map(contributionId => {
            const id = `reactNativeBundle:${input.manifest.id}:${contributionId}`;
            return [id, { id, pluginId: input.manifest.id, occurrenceId, contributionKind: 'reactNativeBundle' as const,
                contributionId, generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: graph, hostAccountOrigin: origin,
                runtime: { decision: { state: 'load' as const }, loadPolicy: { source: 'installedArtifact' as const },
                    cacheIdentity: { artifactDigest: graph.digest } } }];
        })),
    };
    const resolved = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform })
        .filter(entry => entry.pluginId === input.manifest.id);
    if (resolved.length === 0) throw new Error('Authored Account executable was not projected');
    const composition = getInstalledPluginUiClientExecutableComposition();
    const cache = createPluginReactNativeBundleCache();
    let activationFailure: unknown;
    for (const entry of resolved) cache.putInstalledArtifact({ identity: entry.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 102, 105, 120, 116, 117, 114, 101]), format: 'plainJs' });
    const activations: PluginUiClientExecutableActivation[] = resolved.map(entry => ({
        pluginId: entry.pluginId, pluginVersion: entry.pluginVersion, hostUiApiRange: entry.hostUiApiRange,
        contributes: entry.contributes, target: entry.target, executionOrigin: entry.executionOrigin,
        cache, identity: entry.cacheIdentity, moduleReference: entry.moduleReference,
        backend: { backendId: 'commonJs', available: true,
            async loadInstalledBundle() { return async (api: PluginAccountApi) => {
                try { return await input.activate(api); } catch (error) { activationFailure = error; throw error; }
            }; } },
        authority: entry.authority, accountLifetime: input.accountLifetime, occurrenceId,
        ...(input.prepareRegistration ? { prepareRegistration: input.prepareRegistration } : {}),
        isCurrent: input.accountLifetime.isCurrent,
    }));
    const attempts = input.deferActivation ? [] : await composition.reconcile(activations);
    if (attempts.some(attempt => !attempt.result.ok)) {
        await composition.unload();
        throw new Error(`Account fixture activation failed: ${JSON.stringify(attempts.map(attempt => attempt.result))}`,
            { cause: activationFailure });
    }
    return { projection, activations, async dispose() { await composition.invalidatePlugin(input.manifest.id); } };
}

function createPortableAccountExecutableArtifact(account: Readonly<{ artifactId: string; exportName: string }>) {
    const bundlePath = `react-native/${account.artifactId}/entry.cjs.bundle`;
    return PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: account.artifactId,
        tier: 'reactNative', entry: bundlePath,
        files: [{ relativePath: bundlePath, digest: `sha256:${'d'.repeat(64)}`, byteSize: 10 }],
        digest: `sha256:${'a'.repeat(64)}`, builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: [account.exportName] }, hostUiApiRange: '^1.0.0' });
}
