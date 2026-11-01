import type { ResolvedExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import axios from 'axios';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema, PluginAvailabilityUiArtifactReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
    PluginAvailabilityIntentSetActionInputV1Schema, PluginAvailabilityIntentSetActionOutputV1Schema,
    resolvePluginAccountExecutionSelectionV1, createPluginAccountBundledSelectionV1, isPluginUiReleaseSlotCompatibleWithArtifactLinkV1, snapshotPluginReleaseFactsV1,
    type PluginAvailabilityIntentReadActionOutputV1, type PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { createPluginUiArtifactArchiveV1, decodePluginUiArtifactArchiveBodyV1, openPluginUiArtifactArchiveV1,
    type PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizeParsedPluginManifestV2 } from '@/plugins/manifest/normalize';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { PluginActivationSource } from './activationSources';
import { collectActivationTargets } from './lifecycle/activation/targets';
import type { PluginDaemonModuleNamespace } from './types';
import { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } from './sourceAuthority';
import { loadPluginModule } from './loadPluginModule';
import type { createBundledActivationSourceResolver } from './bundledActivationSource';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { resolveBundledPluginEnablement } from '@/plugins/projection/registry/builtIn/enablement';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/builtIn/snapshot';

type AccountBundledSelection = Parameters<typeof resolvePluginAccountExecutionSelectionV1>[0]['bundled'];
type AccountReadBinding = Readonly<{ credentials: StoredCredentials; serverUrl: string; signal?: AbortSignal }>;

async function postAvailability(input: AccountReadBinding, path: string, body: unknown): Promise<unknown> {
    input.signal?.throwIfAborted();
    const response = await axios.post(`${input.serverUrl.replace(/\/+$/, '')}${path}`, body, {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials.token}` },
        timeout: 0, ...(input.signal ? { signal: input.signal } : {}),
    });
    input.signal?.throwIfAborted();
    return response.data;
}

function snapshotIntentRead(pluginId: string, response: PluginAvailabilityIntentReadActionOutputV1): PluginAvailabilityIntentReadActionOutputV1 {
    if ((response.intent && response.intent.pluginId !== pluginId)
        || (response.release && response.release.ref.pluginId !== pluginId)
        || response.uiArtifacts.some(link => link.release.pluginId !== pluginId)
        || response.packageAssets.some(link => link.release.pluginId !== pluginId)) {
        throw new Error('plugin_account_execution_identity_mismatch');
    }
    return Object.freeze({ ...response,
        release: response.release ? snapshotPluginReleaseFactsV1(response.release) : null,
    });
}

async function readIntent(input: AccountReadBinding & Readonly<{ pluginId: string }>) {
    const response = PluginAvailabilityIntentReadActionOutputV1Schema.parse(await postAvailability(input,
        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], { pluginId: input.pluginId }));
    return snapshotIntentRead(input.pluginId, response);
}

/** Preserves the Account selection and hosting contract while changing only enablement. */
export async function setCurrentAccountPluginEnabled(input: AccountReadBinding & Readonly<{
    pluginId: string; enabled: boolean;
    managedResourceDispositions?: import('@happier-dev/protocol/machines/managed/managedDependencyV1').ManagedResourceDispositionV1[];
}>) {
    const { intent } = await readIntent(input);
    const body = PluginAvailabilityIntentSetActionInputV1Schema.parse({
        pluginId: input.pluginId, enabled: input.enabled,
        desiredVersion: intent?.desiredVersion ?? null,
        offlineUiHosting: intent?.offlineUiHosting ?? 'disabled',
        writableCollections: intent?.writableCollections ?? [], expectedRevision: intent?.revision ?? null,
        ...(input.managedResourceDispositions ? { managedResourceDispositions: input.managedResourceDispositions } : {}),
    });
    return PluginAvailabilityIntentSetActionOutputV1Schema.parse(await postAvailability(input,
        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.set'], body));
}

async function readCurrentAccountPluginIntentReads(input: AccountReadBinding & Readonly<{
    pluginIds: readonly string[]; isCurrent?: () => boolean;
}>) {
    const knownPluginIds = [...new Set(input.pluginIds)].sort();
    const reads = new Map<string, PluginAvailabilityIntentReadActionOutputV1>();
    let cursor: string | undefined;
    do {
        const page = PluginAvailabilityIntentsListActionOutputV1Schema.parse(await postAvailability(input,
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
                knownPluginIds: knownPluginIds.filter(id => !cursor || id > cursor).slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1),
                ...(cursor ? { cursor } : {}),
            }));
        if (input.isCurrent?.() === false) throw new Error('plugin_account_execution_retired');
        for (const entry of page.intentReads) {
            const response = snapshotIntentRead(entry.pluginId, entry.response);
            if (reads.has(entry.pluginId)) throw new Error('plugin_account_execution_duplicate_read');
            reads.set(entry.pluginId, response);
        }
        if (page.nextCursor && cursor && page.nextCursor <= cursor) throw new Error('plugin_account_execution_invalid_cursor');
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return reads;
}

/** Account intent is default-on; an unavailable census never becomes an enabled fact. */
export async function readCurrentAccountPluginEnablements(input: AccountReadBinding & Readonly<{
    pluginIds: readonly string[];
}>): Promise<ReadonlyMap<string, boolean>> {
    const reads = await readCurrentAccountPluginIntentReads(input);
    return new Map(input.pluginIds.map(pluginId => {
        const read = reads.get(pluginId);
        if (!read) throw new Error('plugin_account_execution_unavailable');
        return [pluginId, read.intent?.enabled ?? true];
    }));
}

/** One strict Account read for provenance consumers; it owns no cache or occurrence. */
export async function readCurrentAccountPluginExecutionSelection(input: AccountReadBinding & Readonly<{
    pluginId: string; bundled?: AccountBundledSelection;
}>): Promise<PluginAccountExecutionSelectionV1> {
    return resolvePluginAccountExecutionSelectionV1({ pluginId: input.pluginId, intentRead: await readIntent(input),
        ...(input.bundled ? { bundled: input.bundled } : {}) });
}

/** Mounted callers use the authenticated runtime's Account, independently of the Machine plugin source. */
export async function readCurrentMountedAccountPluginExecutionSelection(input: Readonly<{
    pluginId: string;
    registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes'>;
    runtime: Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }>;
    signal?: AbortSignal;
}>): Promise<PluginAccountExecutionSelectionV1> {
    const unavailable = { kind: 'unavailable' as const, code: 'plugin_account_execution_unavailable' as const };
    if (!await input.runtime.isCurrent()) return unavailable;
    const declaration = input.registry.contributes.pluginDeclarations?.find(plugin =>
        plugin.pluginId === input.pluginId && plugin.sourceSpec.kind === 'bundled');
    const bundled = declaration ? createPluginAccountBundledSelectionV1({
        packageName: declaration.sourceSpec.locator, manifest: declaration.manifest,
    }) : undefined;
    const selection = await readCurrentAccountPluginExecutionSelection({ pluginId: input.pluginId, credentials: input.runtime.credentials,
        serverUrl: input.runtime.serverHttpBaseUrl, ...(bundled ? { bundled } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    return await input.runtime.isCurrent() ? selection : unavailable;
}

export type AccountPluginActivationSourcesInput = Readonly<{
    contributes: ResolvedContributionRegistry;
    machineEnabledById?: Readonly<Record<string, boolean>>;
    paths: PluginStorePaths;
    credentials: StoredCredentials;
    serverUrl: string;
    isCurrent: () => boolean;
    isCredentialCurrent?: () => boolean | Promise<boolean>;
    resolveBundledActivationSource: (...args: Parameters<ReturnType<typeof createBundledActivationSourceResolver>>) => PluginActivationSource<PluginDaemonModuleNamespace> | null;
    signal?: AbortSignal;
}>;

export type AccountPluginActivationSources = Readonly<{
    contributes: ResolvedContributionRegistry;
    sourcesByPluginId: ReadonlyMap<string, PluginActivationSource<PluginDaemonModuleNamespace>>;
    isCurrent: (pluginId: string) => boolean;
    revalidate: (pluginId: string, signal?: AbortSignal) => Promise<boolean>;
    /** Captured strict census outcome; execution still revalidates custody. */
    readSelection: (pluginId: string) => PluginAccountExecutionSelectionV1 | null;
}>;

/** Supplies Account custody to the existing registry and module evaluator. */
export async function resolveAccountPluginActivationSources(input: AccountPluginActivationSourcesInput): Promise<AccountPluginActivationSources> {
    const bundledDeclarations = (input.contributes.pluginDeclarations ?? []).filter(plugin => plugin.sourceSpec.kind === 'bundled');
    const knownPluginIds = bundledDeclarations.map(plugin => plugin.pluginId).sort();
    const reads = await readCurrentAccountPluginIntentReads({ ...input, pluginIds: knownPluginIds });
    const pluginEnablementById = resolveBundledPluginEnablement({ pluginIds: [...reads.keys()],
        accountEnabledById: new Map([...reads].map(([pluginId, read]) => [pluginId, read.intent?.enabled ?? true])),
        machineEnabledById: input.machineEnabledById,
    });

    const sourcesByPluginId = new Map<string, PluginActivationSource<PluginDaemonModuleNamespace>>();
    const selected = new Map<string, Readonly<{ selection: PluginAccountExecutionSelectionV1;
        read: PluginAvailabilityIntentReadActionOutputV1; bundled?: AccountBundledSelection }>>();
    const retired = new Set<string>();
    const isCurrent = (pluginId: string) => input.isCurrent() && sourcesByPluginId.has(pluginId) && !retired.has(pluginId);
    const revalidate = async (pluginId: string, signal?: AbortSignal): Promise<boolean> => {
        if (!isCurrent(pluginId)) return false;
        const admitted = selected.get(pluginId)!;
        try {
            if (await input.isCredentialCurrent?.() === false) {
                retired.add(pluginId);
                return false;
            }
            const read = await readIntent({ ...input, pluginId, ...(signal ? { signal } : {}) });
            const next = resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: read,
                ...(admitted.bundled ? { bundled: admitted.bundled } : {}) });
            if (await input.isCredentialCurrent?.() === false || !isCurrent(pluginId) || next.kind !== 'available'
                || admitted.selection.kind !== 'available' || next.custodyId !== admitted.selection.custodyId) {
                retired.add(pluginId);
                return false;
            }
            return true;
        } catch { retired.add(pluginId); return false; }
    };
    const external: LoadedPlugin[] = [];
    const bundled: LoadedPlugin[] = [];
    for (const [pluginId, read] of reads) {
        const hostDeclaration = bundledDeclarations.find(plugin => plugin.pluginId === pluginId);
        const hostAccountAction = hostDeclaration?.manifest.contributes.actions.find(action => action.execution.target === 'account');
        const hostTarget = hostDeclaration ? { pluginId, manifest: hostDeclaration.manifest,
            manifestPath: hostDeclaration.manifestPath, sourceSpec: hostDeclaration.sourceSpec,
            pluginRootPath: hostDeclaration.pluginRootPath,
            daemonEntryPath: hostDeclaration.daemonEntryPath, devDaemonEntryPath: hostDeclaration.devDaemonEntryPath,
            ...(hostAccountAction?.execution.target === 'account' ? { account: hostAccountAction.execution.account } : {}),
            provenance: 'first_party' as const, source: { kind: 'bundled' as const } } : null;
        let accountSelection: PluginAccountExecutionSelectionV1 = pluginEnablementById[pluginId]?.enabled === false
            ? { kind: 'unavailable', code: 'plugin_disabled' }
            : resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: read });
        let hostSource: PluginActivationSource<PluginDaemonModuleNamespace> | null = null;
        let bundledSelection: AccountBundledSelection;
        // An explicit Account override is authoritative independently of the
        // optional host bundle. Only the shared selector's no-selection result
        // needs the existing bundled declaration/root owner.
        if (accountSelection.kind === 'unavailable' && accountSelection.code === 'plugin_account_execution_unavailable' && hostTarget) {
            hostSource = input.resolveBundledActivationSource(hostTarget, { realm: 'account' });
            const hostCustody = hostSource?.sourceAuthority?.kind === 'bundled_first_party'
                ? resolvePluginSourceCustody(hostSource.sourceAuthority) : null;
            if (hostDeclaration && hostCustody) {
                bundledSelection = createPluginAccountBundledSelectionV1({
                    packageName: hostDeclaration.sourceSpec.locator,
                    manifest: hostDeclaration.manifest, sourceCustody: hostCustody,
                });
                accountSelection = resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: read, bundled: bundledSelection });
            }
        }
        // Machine-only sources still supply admitted descriptors and operation
        // declarations. Placement limits activation, not release custody.
        const selection = accountSelection;
        selected.set(pluginId, { selection, read, ...(bundledSelection ? { bundled: bundledSelection } : {}) });
        if (selection.kind !== 'available') continue;
        const manifest = normalizeParsedPluginManifestV2(selection.manifest);
        const root = selection.release ? join(input.paths.cacheDir, 'account-artifacts', selection.release.archiveDigestSha256.slice(7), pluginId)
            : hostSource?.sourceAuthority?.kind === 'bundled_first_party' ? hostSource.sourceAuthority.resolvedRoot : null;
        if (!root) continue;
        const graphs = new Map<string, PluginUiArtifactsManifestEntryV2>();
        for (const slot of selection.release?.uiSlots ?? []) if (slot.artifactGraph) graphs.set(slot.artifactId, slot.artifactGraph);
        if (!selection.release) for (const graph of hostDeclaration?.generatedUiArtifactsManifest?.entries ?? []) graphs.set(graph.artifactId, graph);
        const declaration: LoadedPlugin = selection.release ? { pluginId, pluginRootPath: root,
            manifestPath: join(root, '.happier-plugin', 'plugin.json'), daemonEntryPath: null, devDaemonEntryPath: null, manifest,
            // This declaration is not a Machine installation or a local-trust
            // grant. Execution is admitted solely by current Account custody.
            sourceSpec: { kind: 'archive', locator: `account-release:${pluginId}@${manifest.version}`, resolvedPath: root,
                resolvedVersion: manifest.version, trustPolicy: 'prompt', installPolicy: 'copy' },
            generatedUiArtifactsManifest: { version: 2, entries: [...graphs.values()] } } : { ...hostDeclaration!, manifest };
        (selection.release ? external : bundled).push(declaration);
        const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: selection.sourceCustody, resolvedRoot: root });
        sourcesByPluginId.set(pluginId, { kind: 'bundled', moduleId: selection.custodyId, sourceAuthority,
            load: async () => { throw new Error('Account execution requires its declared artifact'); },
            resolveRelativeModule: async artifactId => {
                if (!(await revalidate(pluginId, input.signal))) throw new Error('plugin_account_execution_retired');
                const graph = graphs.get(artifactId);
                if (!graph || graph.tier !== 'reactNative') throw new Error('plugin_account_execution_artifact_unavailable');
                let entryPath: string;
                if (selection.release) {
                    const release = selection.release;
                    const slot = release.uiSlots.find(slot => slot.artifactId === artifactId && slot.platform === 'web' && slot.tier === 'reactNative');
                    const link = slot ? read.uiArtifacts.find(link => link.release.version === release.ref.version
                        && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, link)) : null;
                    if (!slot || !link) throw new Error('plugin_account_execution_artifact_unavailable');
                    const response = PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse(await postAvailability(input,
                        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read'],
                        PluginAvailabilityUiArtifactReadActionInputV1Schema.parse({ release: release.ref,
                            contributionId: slot.contributionId, artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform })));
                    if (createCanonicalJsonSigningInput(response.link) !== createCanonicalJsonSigningInput(link)) {
                        throw new Error('plugin_account_execution_identity_mismatch');
                    }
                    const artifact = await runWithServerHttpBaseUrl(input.serverUrl, () => createCredentialedAccountArtifactStore(input.credentials)
                        .openStoredEnvelope(response.artifact, { signal: input.signal }));
                    if (typeof artifact.body !== 'string') throw new Error('plugin_account_execution_artifact_unavailable');
                    const opened = openPluginUiArtifactArchiveV1({ pluginId, expectedArtifactDigest: graph.digest,
                        header: artifact.header, body: decodePluginUiArtifactArchiveBodyV1(artifact.body) });
                    if (!opened || createCanonicalJsonSigningInput(opened.artifactGraph) !== createCanonicalJsonSigningInput(graph)) {
                        throw new Error('plugin_account_execution_artifact_invalid');
                    }
                    for (const [relativePath, bytes] of opened.files) {
                        const path = join(root, relativePath);
                        await mkdir(dirname(path), { recursive: true });
                        try { await writeFile(path, bytes, { flag: 'wx' }); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
                        if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) throw new Error('plugin_account_execution_cache_invalid');
                    }
                    entryPath = resolve(root, graph.entry);
                } else {
                    if (hostSource?.kind === 'bundled') await hostSource.prepare?.();
                    const artifactRoot = resolve(root, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
                    const files = await Promise.all(graph.files.map(async file => ({ relativePath: file.relativePath,
                        bytes: await readFile(resolve(artifactRoot, file.relativePath)) })));
                    if (!createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: graph, files })) {
                        throw new Error('plugin_account_execution_artifact_invalid');
                    }
                    entryPath = resolve(artifactRoot, graph.entry);
                }
                if (!(await revalidate(pluginId, input.signal))) throw new Error('plugin_account_execution_retired');
                const accountScopeKey = runWithServerHttpBaseUrl(input.serverUrl, () => resolveAccountSettingsScopeKey(input.credentials));
                const module = await loadPluginModule({ source: { kind: 'file_backed', entryPath, sourceAuthority },
                    cacheKey: JSON.stringify([accountScopeKey, selection.custodyId]) });
                if (!isCurrent(pluginId)) throw new Error('plugin_account_execution_retired');
                return { module, normalizedModulePath: entryPath, loadMode: 'immutable-js' };
            } });
    }
    const contributes = createMergedContributionRegistry(projectLoadedPluginContributes({ provenance: 'external',
        loadResult: { loadedPlugins: external, diagnosticsByPluginId: {} } }), projectLoadedPluginContributes({ provenance: 'first_party',
        loadResult: { loadedPlugins: bundled, diagnosticsByPluginId: {} } }));
    const activationTargets = collectActivationTargets(contributes, 'account');
    // Agents and Resources have only a Machine/daemon execution host. Keep
    // their declarations in the selected manifest without synthesizing an
    // executable Agent runtime or demanding an Account Resource registration.
    return { contributes: { ...contributes, agents: [], resources: [], activationTargets, pluginEnablementById,
        unavailableAgentPluginsByBackendId: getResolvedContributionRegistry({ pluginEnablementById }).unavailableAgentPluginsByBackendId,
    }, sourcesByPluginId, isCurrent, revalidate,
        readSelection: pluginId => selected.get(pluginId)?.selection ?? null };
}
