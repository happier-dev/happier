import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { derivePluginAccountExecutionArtifactSlots } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema, PluginAvailabilityUiArtifactReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
    PluginAvailabilityIntentSetActionInputV1Schema, PluginAvailabilityIntentSetActionOutputV1Schema,
    resolvePluginAccountExecutionSelectionV1, createPluginAccountBundledSelectionV1, isPluginUiReleaseSlotCompatibleWithArtifactLinkV1,
    type PluginAvailabilityIntentReadActionOutputV1, type PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { createPluginUiArtifactArchiveV1, decodePluginUiArtifactArchiveBodyV1, openPluginUiArtifactArchiveV1 } from '@happier-dev/protocol/plugins/ui/artifactArchive';
import type { PluginUiArtifactsManifestEntryV2 } from '@happier-dev/protocol/plugins/ui/uiArtifactsManifest';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
    assertIntentPage, postAvailability, readNamedAccountPluginIntentReads, snapshotIntentRead,
    type AccountReadBinding,
} from '@/plugins/availability/accountReads';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { StoredCredentials } from '@/persistence';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH } from '@/plugins/install/ui/generatedArtifacts';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { PluginStorePaths } from '@/plugins/store/paths';
import type { PluginActivationSource } from './activationSources';
import { collectActivationTargets } from './lifecycle/activation/targets';
import type { PluginDaemonModuleNamespace } from './types';
import { bindPluginRuntimeSourceAuthority, resolvePluginSourceCustody } from './sourceAuthority';
import { isImmutablePluginModuleLoaded, loadPluginModule } from './loadPluginModule';
import type { createBundledActivationSourceResolver } from './bundledActivationSource';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { resolveBundledPluginEnablement, withAccountPluginProjectScopes } from '@/plugins/projection/registry/builtIn/enablement';
import { resolveUnavailableAgentPluginsByBackendId } from '@/plugins/projection/registry/builtIn/snapshot';
import { PluginDiagnosticError } from './moduleFailure';
import { projectAccountContributionRegistry } from './accountContributionProjection';
import { publishAccountPluginArtifactFiles } from './publishAccountPluginArtifactFiles';

type AccountBundledSelection = Parameters<typeof resolvePluginAccountExecutionSelectionV1>[0]['bundled'];

function accountArtifactUnavailable(message: string): PluginDiagnosticError {
    return new PluginDiagnosticError({ code: 'plugin_account_execution_artifact_unavailable', message });
}

function missingHostedAccountArtifact(read: PluginAvailabilityIntentReadActionOutputV1): PluginDiagnosticError {
    if (!read.hostingCapability.enabled) {
        return accountArtifactUnavailable('Ask your Happier Home administrator to enable plugin artifact hosting, then try again.');
    }
    if (read.intent?.offlineUiHosting !== 'enabled') {
        return accountArtifactUnavailable('Enable artifact hosting for this plugin in Plugins, then try again.');
    }
    return accountArtifactUnavailable('Connect a Machine with the selected plugin version installed and trusted. Wait for artifact hosting to finish, then try again.');
}

async function readIntent(input: AccountReadBinding & Readonly<{ pluginId: string; omitDeclarations?: true }>) {
    const response = PluginAvailabilityIntentReadActionOutputV1Schema.parse(await postAvailability(input,
        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], { pluginId: input.pluginId,
            ...(input.omitDeclarations ? { omitDeclarations: true } : {}) }));
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

/**
 * The Account intent census: every Account intent (Account releases this
 * Machine does not declare) plus the caller-known ids, paged to completion.
 */
async function readCurrentAccountPluginIntentCensus(input: AccountReadBinding & Readonly<{
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
                // Execution selection consumes intent and release facts, never declaration bodies.
                omitDeclarations: true,
            }));
        assertIntentPage(input, page, reads);
        if (page.nextCursor && cursor && page.nextCursor <= cursor) throw new Error('plugin_account_execution_invalid_cursor');
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (knownPluginIds.some(pluginId => !reads.has(pluginId))) throw new Error('plugin_account_execution_unavailable');
    return reads;
}

/** Account intent is default-on; an unavailable census never becomes an enabled fact. */
export async function readCurrentAccountPluginEnablements(input: AccountReadBinding & Readonly<{
    pluginIds: readonly string[];
}>): Promise<ReadonlyMap<string, boolean>> {
    const intents = await readCurrentAccountPluginEnablementIntents(input);
    return new Map(input.pluginIds.map(pluginId => [pluginId, intents.get(pluginId)?.enabled ?? true]));
}

/** Exact admitted intent facts for Machine and Session contribution availability. */
export async function readCurrentAccountPluginEnablementIntents(input: AccountReadBinding & Readonly<{
    pluginIds: readonly string[];
}>) {
    const reads = await readNamedAccountPluginIntentReads(input);
    return new Map([...reads].map(([pluginId, read]) => [pluginId, read.intent]));
}

/** One strict Account read for provenance consumers; it owns no cache or occurrence. */
export async function readCurrentAccountPluginExecutionSelection(input: AccountReadBinding & Readonly<{
    pluginId: string; bundled?: AccountBundledSelection;
}>): Promise<PluginAccountExecutionSelectionV1> {
    const intentRead = await readIntent(input);
    const selection = resolvePluginAccountExecutionSelectionV1({ pluginId: input.pluginId, intentRead,
        ...(input.bundled ? { bundled: input.bundled } : {}) });
    // Only the policy owner's no-selection result needs host bundled facts.
    if (input.bundled || selection.kind === 'available' || selection.code !== 'plugin_account_execution_unavailable') return selection;
    const declaration = loadCurrentBundledPluginLocatorResult({ pluginIds: [input.pluginId] }).loadedPlugins
        .find(plugin => plugin.pluginId === input.pluginId);
    if (!declaration) return selection;
    return resolvePluginAccountExecutionSelectionV1({ pluginId: input.pluginId, intentRead,
        bundled: createPluginAccountBundledSelectionV1({
            packageName: declaration.sourceSpec.locator, manifest: declaration.manifest,
        }) });
}

/** Cold discovery uses Account custody without loading or activating a daemon module. */
export async function readCurrentAccountPluginExecutionDeclarations(input: AccountReadBinding & Readonly<{
    family: 'machineProvisioners' | 'connectedAccountDescriptors'; pluginId?: string;
}>): Promise<Readonly<{ kind: 'available'; declarations: readonly Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>[] }>
    | Extract<PluginAccountExecutionSelectionV1, { kind: 'unavailable' }>> {
    const bundled = loadCurrentBundledPluginLocatorResult(input.pluginId ? { pluginIds: [input.pluginId] } : undefined).loadedPlugins
        .filter(plugin => input.pluginId !== undefined || (plugin.manifest.contributes[input.family]?.length ?? 0) > 0);
    const bundledById = new Map(bundled.map(plugin => [plugin.pluginId, createPluginAccountBundledSelectionV1({
        packageName: plugin.sourceSpec.locator, manifest: plugin.manifest,
    })]));
    if (input.pluginId !== undefined) {
        const selection = await readCurrentAccountPluginExecutionSelection({ ...input,
            pluginId: input.pluginId, bundled: bundledById.get(input.pluginId) });
        return selection.kind === 'available' ? { kind: 'available', declarations: [selection] } : selection;
    }
    const reads = await readCurrentAccountPluginIntentCensus({ ...input, pluginIds: [...bundledById.keys()] });
    const declarations = [...reads].flatMap(([pluginId, intentRead]) => {
        const selection = resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead, bundled: bundledById.get(pluginId) });
        return selection.kind === 'available' && (selection.manifest.contributes[input.family]?.length ?? 0) > 0 ? [selection] : [];
    });
    return { kind: 'available', declarations };
}

/** Mounted callers use the authenticated runtime's Account, independently of the Machine plugin source. */
export async function readCurrentMountedAccountPluginExecutionSelection(input: Readonly<{
    pluginId: string;
    runtime: Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string; isCurrent(): Promise<boolean> }>;
    signal?: AbortSignal;
}>): Promise<PluginAccountExecutionSelectionV1> {
    const unavailable = { kind: 'unavailable' as const, code: 'plugin_account_execution_unavailable' as const };
    if (!await input.runtime.isCurrent()) return unavailable;
    const selection = await readCurrentAccountPluginExecutionSelection({ pluginId: input.pluginId, credentials: input.runtime.credentials,
        serverUrl: input.runtime.serverHttpBaseUrl, ...(input.signal ? { signal: input.signal } : {}) });
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
    /** False is confirmed retirement; cancellation and unavailable custody reads reject. */
    revalidate: (pluginId: string, signal?: AbortSignal) => Promise<boolean>;
    /** Captured strict census outcome; execution still revalidates custody. */
    readSelection: (pluginId: string) => PluginAccountExecutionSelectionV1 | null;
}>;

/** Supplies Account custody to the existing registry and module evaluator. */
export async function resolveAccountPluginActivationSources(input: AccountPluginActivationSourcesInput): Promise<AccountPluginActivationSources> {
    const bundledDeclarations = (input.contributes.pluginDeclarations ?? []).filter(plugin => plugin.sourceSpec.kind === 'bundled');
    const bundledPluginIds = bundledDeclarations.map(plugin => plugin.pluginId).sort();
    const reads = await readCurrentAccountPluginIntentCensus({ ...input, pluginIds: bundledPluginIds });
    const accountScopeKey = runWithServerHttpBaseUrl(input.serverUrl, () => resolveAccountSettingsScopeKey(input.credentials));
    const enablement = resolveBundledPluginEnablement({ pluginIds: [...reads.keys()],
        accountEnabledById: new Map([...reads].map(([pluginId, read]) => [pluginId, read.intent?.enabled ?? true])),
        machineEnabledById: input.machineEnabledById,
    });
    const pluginEnablementById = withAccountPluginProjectScopes(enablement, [...reads].map(([pluginId, read]) => [pluginId, read.intent] as const));

    const sourcesByPluginId = new Map<string, PluginActivationSource<PluginDaemonModuleNamespace>>();
    const selected = new Map<string, Readonly<{ selection: PluginAccountExecutionSelectionV1;
        read: PluginAvailabilityIntentReadActionOutputV1; bundled?: AccountBundledSelection }>>();
    const retired = new Set<string>();
    const isCurrent = (pluginId: string) => input.isCurrent() && sourcesByPluginId.has(pluginId) && !retired.has(pluginId);
    const revalidate = async (pluginId: string, signal?: AbortSignal): Promise<boolean> => {
        const admissionSignal = signal ?? input.signal;
        admissionSignal?.throwIfAborted();
        if (!isCurrent(pluginId)) return false;
        const admitted = selected.get(pluginId)!;
        try {
            if (await input.isCredentialCurrent?.() === false) {
                retired.add(pluginId);
                return false;
            }
            const read = await readIntent({ ...input, pluginId, omitDeclarations: true, ...(signal ? { signal } : {}) });
            const next = resolvePluginAccountExecutionSelectionV1({ pluginId, intentRead: read,
                ...(admitted.bundled ? { bundled: admitted.bundled } : {}) });
            if (await input.isCredentialCurrent?.() === false || !isCurrent(pluginId) || next.kind !== 'available'
                || admitted.selection.kind !== 'available' || next.custodyId !== admitted.selection.custodyId) {
                retired.add(pluginId);
                return false;
            }
            return true;
        } catch (error) {
            admissionSignal?.throwIfAborted();
            if (isPluginError(error)) throw error;
            // A failed read refuses this admission without asserting retirement
            // or retaining transport content that may contain credentials.
            throw new PluginError({ code: 'plugin_account_execution_unavailable',
                message: 'Account execution custody is unavailable',
                failureCause: projectActionFailureCauseV1(error, 'plugin.account_execution.revalidate') });
        }
    };
    const declarations: { declaration: LoadedPlugin; custodyId: string }[] = [];
    for (const [pluginId, read] of reads) {
        const hostDeclaration = bundledDeclarations.find(plugin => plugin.pluginId === pluginId);
        const hostAccountTarget = hostDeclaration && derivePluginAccountExecutionArtifactSlots(
            hostDeclaration.manifest.contributes,
        )[0]?.registrationRight.target;
        const hostTarget = hostDeclaration ? { pluginId, manifest: hostDeclaration.manifest,
            manifestPath: hostDeclaration.manifestPath, sourceSpec: hostDeclaration.sourceSpec,
            pluginRootPath: hostDeclaration.pluginRootPath,
            daemonEntryPath: hostDeclaration.daemonEntryPath, devDaemonEntryPath: hostDeclaration.devDaemonEntryPath,
            ...(hostAccountTarget
                ? { account: { artifactId: hostAccountTarget.artifactId, exportName: hostAccountTarget.exportName } } : {}),
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
        const manifest = selection.manifest;
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
        declarations.push({ declaration, custodyId: selection.custodyId });
        const sourceAuthority = bindPluginRuntimeSourceAuthority({ custody: selection.sourceCustody, resolvedRoot: root });
        sourcesByPluginId.set(pluginId, { kind: 'bundled', moduleId: selection.custodyId, sourceAuthority,
            load: async () => { throw new Error('Account execution requires its declared artifact'); },
            // Module loading belongs to the request that admitted this Account
            // custody (the census above, plus the Action/Resource admission).
            resolveRelativeModule: async artifactId => {
                if (!isCurrent(pluginId)) throw new Error('plugin_account_execution_retired');
                const graph = graphs.get(artifactId);
                const release = selection.release;
                if (!graph || graph.tier !== 'reactNative') {
                    throw accountArtifactUnavailable(release
                        ? 'Install a plugin package that includes its Account runtime, then select that version in Plugins.'
                        : 'Update Happier to install the bundled plugin’s Account runtime, then try again.');
                }
                const slot = release?.uiSlots.find(slot => slot.artifactId === artifactId && slot.platform === 'web' && slot.tier === 'reactNative');
                const link = release && slot ? read.uiArtifacts.find(link => link.release.version === release.ref.version
                    && isPluginUiReleaseSlotCompatibleWithArtifactLinkV1(slot, link)) : null;
                if (release && !slot) {
                    throw accountArtifactUnavailable('Install a plugin package that includes its Account runtime, then select that version in Plugins.');
                }
                if (release && !link) throw missingHostedAccountArtifact(read);
                const artifactRoot = resolve(root, GENERATED_PLUGIN_UI_ARTIFACTS_ROOT_RELATIVE_PATH);
                const entryPath = resolve(release ? root : artifactRoot, graph.entry);
                const cacheKey = JSON.stringify([accountScopeKey, selection.custodyId]);
                // This call's census decided use above. The custody identity pins the
                // content, so a module already held in process needs no bytes again.
                const held = isImmutablePluginModuleLoaded({ entryPath, cacheKey });
                if (!held && release && slot && link) {
                    const response = PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse(await postAvailability(input,
                        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read'],
                        PluginAvailabilityUiArtifactReadActionInputV1Schema.parse({ release: release.ref,
                            contributionId: slot.contributionId, artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform })));
                    if (createCanonicalJsonSigningInput(response.link) !== createCanonicalJsonSigningInput(link)) {
                        throw new Error('plugin_account_execution_identity_mismatch');
                    }
                    const artifact = await runWithServerHttpBaseUrl(input.serverUrl, () => createCredentialedAccountArtifactStore(input.credentials)
                        .openStoredEnvelope(response.artifact, { signal: input.signal }));
                    if (typeof artifact.body !== 'string') throw new Error('plugin_account_execution_artifact_invalid');
                    const opened = openPluginUiArtifactArchiveV1({ pluginId, expectedArtifactDigest: graph.digest,
                        header: artifact.header, body: decodePluginUiArtifactArchiveBodyV1(artifact.body) });
                    if (!opened || createCanonicalJsonSigningInput(opened.artifactGraph) !== createCanonicalJsonSigningInput(graph)) {
                        throw new Error('plugin_account_execution_artifact_invalid');
                    }
                    await publishAccountPluginArtifactFiles(root, opened.files);
                } else if (!held) {
                    if (hostSource?.kind === 'bundled') await hostSource.prepare?.();
                    const files = await Promise.all(graph.files.map(async file => ({ relativePath: file.relativePath,
                        bytes: await readFile(resolve(artifactRoot, file.relativePath)) })));
                    if (!createPluginUiArtifactArchiveV1({ pluginId, artifactGraph: graph, files })) {
                        throw new Error('plugin_account_execution_artifact_invalid');
                    }
                }
                const module = await loadPluginModule({ source: { kind: 'file_backed', entryPath, sourceAuthority }, cacheKey });
                return { module, normalizedModulePath: entryPath, loadMode: 'immutable-js' };
            } });
    }
    const contributes = projectAccountContributionRegistry({ host: input.contributes, accountScopeKey, selected: declarations });
    const activationTargets = collectActivationTargets(contributes, 'account');
    // Scope is contextual identity, not placement. Only explicitly portable
    // producers belong to this Account-selected execution projection.
    const resources = contributes.resources.filter(resource => 'execution' in resource.definition
        && resource.definition.execution?.target === 'account');
    return { contributes: { ...contributes, agents: [], resources, activationTargets, pluginEnablementById,
        unavailableAgentPluginsByBackendId: resolveUnavailableAgentPluginsByBackendId(pluginEnablementById),
    }, sourcesByPluginId, isCurrent, revalidate,
        readSelection: pluginId => selected.get(pluginId)?.selection ?? null };
}
