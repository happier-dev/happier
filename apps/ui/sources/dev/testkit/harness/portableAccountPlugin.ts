import { ingestPluginManifestV2} from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginProjectedActionV2Schema, PluginProjectionInstalledPackageV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    normalizePluginAccountCollectionContractV1} from '@happier-dev/protocol/plugins/data/collectionsV1';
import { PluginAccountCollectionContributionV1Schema} from '@happier-dev/protocol/plugins/data/collectionContributionV1';
import {
    createPackageAssetArchiveV1} from '@happier-dev/protocol/plugins/availability/packageAssetV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema} from '@happier-dev/protocol/plugins/availability/v1';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability/compatibilityProjectionV1';
import { validatePublicPluginManifestPolicy } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { resolveProjectedPluginUiClientExecutables } from '@/components/plugins/reactNative/clientExecutableProjection';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/projection';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import type { PluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';

/** Admit a real portable release before installing its Account executable at the byte-loader boundary. */
export async function installPortableAccountPluginReleaseForTest(
    input: Omit<Parameters<typeof installPortableAccountPluginForTest>[0], 'origin'>,
) {
    const manifest = PluginPortableReleaseManifestV1Schema.parse(input.manifest);
    const contracts = (manifest.contributes.accountCollections ?? []).map(contribution => normalizePluginAccountCollectionContractV1({
        pluginId: manifest.id, contribution: PluginAccountCollectionContributionV1Schema.parse(contribution),
    }));
    // Only release asset descriptors are needed; these tests load the executable through the byte-loader boundary below.
    const archive = createPackageAssetArchiveV1({ manifest, files: manifest.contributes.resources.flatMap(resource =>
        resource.kind === 'asset' && 'path' in resource ? [{ path: resource.path, bytes: new TextEncoder().encode('{}') }] : []) });
    if (!archive) throw new Error('Missing portable package asset fixture');
    const refs = contracts.map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({ pluginId, collectionId, schemaVersion, contractDigest }));
    const scope = input.accountLifetime.scope;
    const availability = { scope, snapshot: {
        availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: manifest.id,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1, packageAssets: [],
                hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'enabled',
                    writableCollections: refs, revision: 'intent-1' },
                release: { ref: { pluginId: manifest.id, version: manifest.version },
                    archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: manifest,
                    collectionContracts: refs, uiSlots: [], packageAssetArchive: archive.descriptor },
                uiArtifacts: [] }) }],
    } };
    replacePluginAccountAvailabilityProjection(availability);
    const selected = readPluginAccountAvailability(scope).readCurrentAccountExecution(manifest.id);
    if (selected.kind !== 'available') throw new Error(`Portable Account fixture is not admitted: ${selected.code}`);
    if (selected.sourceCustody.kind !== 'account_release') throw new Error('Expected the admitted portable release custody');
    const installed = await installPortableAccountPluginForTest({ ...input,
        origin: { ...scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody } });
    return { ...installed, disable() {
        replacePluginAccountAvailabilityProjection({ ...availability, snapshot: { ...availability.snapshot,
            availabilityCursor: availability.snapshot.availabilityCursor + 1,
            intentReads: availability.snapshot.intentReads.map(read => ({ ...read, response: { ...read.response,
                intent: read.response.intent ? { ...read.response.intent, enabled: false } : null } })),
        } });
        return readPluginAccountAvailability(scope).readAccountUiProjection();
    } };
}

/**
 * Install real authored Account activation at the executable-byte loader boundary.
 * Admission, registration, current-context dispatch and invocation services stay real.
 * Install HTTP/Socket boundaries before importing this runtime-bearing harness.
 */
export async function installPortableAccountPluginForTest(input: Readonly<{
    manifest: PluginManifest;
    activate(api: PluginAccountApi): void | Promise<void>;
    accountLifetime: ActiveServerAccountScopeLifetime;
    origin?: PluginUiAccountExecutableOrigin;
    /** Model the AppShell's scoped publication for ordinary host dependencies. */
    publishProjection?: boolean;
}>) {
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
    const bundlePath = `react-native/${account.artifactId}/entry.cjs.bundle`;
    const occurrenceId = input.origin?.custodyId ?? `account-fixture-${input.manifest.id}`;
    const origin = input.origin ?? { ...input.accountLifetime.scope, custodyId: occurrenceId,
        sourceCustody: { kind: 'account_release' as const, pluginId: input.manifest.id, version: input.manifest.version,
            archiveDigestSha256: `sha256:${'a'.repeat(64)}` } };
    const authorization = { generation: { targetGeneration: occurrenceId, desiredGeneration: occurrenceId, appliedGeneration: occurrenceId },
        resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] };
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: account.artifactId,
        tier: 'reactNative', entry: bundlePath,
        files: [{ relativePath: bundlePath, digest: `sha256:${'d'.repeat(64)}`, byteSize: 10 }],
        digest: `sha256:${'a'.repeat(64)}`, builtWith: { bundler: 'esbuild', version: '0.27.2' },
        executable: { exports: [account.exportName] }, hostUiApiRange: '^1.0.0' });
    const projectedActions = actions.map(declaration => {
        const { hostAccess: _hostAccess, inputSchema: _inputSchema, resultSchema: _resultSchema, ...projected } = declaration;
        return { ...PluginProjectedActionV2Schema.parse({ ...projected, pluginId: input.manifest.id,
            occurrenceId, available: true, authorization }), hostAccountOrigin: origin, accountActionDeclaration: declaration };
    });
    const projectedResources = resources.map(declaration => ({ id: declaration.id, pluginId: input.manifest.id,
        occurrenceId, resourceKind: declaration.kind, scope: declaration.scope,
        contentType: declaration.contentType, execution: declaration.execution,
        hostAccountOrigin: origin, accountResourceDeclaration: declaration }));
    const contributionIds = [...projectedActions.map(action => action.id), ...projectedResources.map(resource => `resources/${resource.id}`)];
    const projection: PluginUiProjectionModel = {
        ...EMPTY_PLUGIN_UI_PROJECTION, generation: 1,
        installedPackagesById: { [input.manifest.id]: PluginProjectionInstalledPackageV2Schema.parse({
            id: input.manifest.id, displayName: input.manifest.displayName, version: input.manifest.version,
            enabled: true, source: { kind: 'localPath', locator: input.manifest.id },
        }) },
        actionsById: Object.fromEntries(projectedActions.map(action => [`${input.manifest.id}/${action.id}`, action])),
        resourcesById: Object.fromEntries(projectedResources.map(resource => [`${input.manifest.id}/${resource.id}`, resource])),
        reactNativeBundlesById: Object.fromEntries(contributionIds.map(contributionId => {
            const id = `reactNativeBundle:${input.manifest.id}:${contributionId}`;
            return [id, { id, pluginId: input.manifest.id, occurrenceId, contributionKind: 'reactNativeBundle' as const,
                contributionId, generatedOwnerKind: 'clientContribution' as const,
                artifactGraph: graph, hostAccountOrigin: origin,
                runtime: { decision: { state: 'load' as const }, loadPolicy: { source: 'installedArtifact' as const },
                    cacheIdentity: { artifactDigest: graph.digest } } }];
        })),
    };
    const resolved = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection }, platform });
    if (resolved.length === 0) throw new Error('Authored Account executable was not projected');
    const composition = getInstalledPluginUiClientExecutableComposition();
    const cache = createPluginReactNativeBundleCache();
    let activationFailure: unknown;
    for (const entry of resolved) cache.putInstalledArtifact({ identity: entry.cacheIdentity,
        bytes: new Uint8Array([47, 47, 32, 102, 105, 120, 116, 117, 114, 101]), format: 'plainJs' });
    const attempts = await composition.reconcile(resolved.map(entry => ({
        pluginId: entry.pluginId, pluginVersion: entry.pluginVersion, hostUiApiRange: entry.hostUiApiRange,
        contributes: entry.contributes, target: entry.target, executionOrigin: entry.executionOrigin,
        cache, identity: entry.cacheIdentity, moduleReference: entry.moduleReference,
        backend: { backendId: 'commonJs', available: true,
            async loadInstalledBundle() { return async (api: PluginAccountApi) => {
                try { return await input.activate(api); } catch (error) { activationFailure = error; throw error; }
            }; } },
        authority: entry.authority, accountLifetime: input.accountLifetime, occurrenceId,
        isCurrent: input.accountLifetime.isCurrent,
    })));
    if (attempts.some(attempt => !attempt.result.ok)) {
        await composition.unload();
        throw new Error(`Account fixture activation failed: ${JSON.stringify(attempts.map(attempt => attempt.result))}`,
            { cause: activationFailure });
    }
    const unregister = registerCurrentUiContextActionPort((invocationSurface, hostAction) => createCurrentUiContextVoiceToolPort({
        invocationSurface, hostAction, readProjection: () => projection, readNavigationBinding: () => null,
        reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
    }));
    const unpublish = input.publishProjection ? publishCommittedAppShellPluginUiProjection(read =>
        input.accountLifetime.isCurrent() && (!read || read.scope.accountId === input.accountLifetime.scope.accountId
            && areServerProfileIdentifiersEquivalent(read.scope.serverId, input.accountLifetime.scope.serverId)) ? projection : null) : undefined;
    return { projection, async dispose() { unpublish?.(); unregister(); await composition.invalidatePlugin(input.manifest.id); } };
}
