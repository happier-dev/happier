import { basename, dirname, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
    resolveFirstPartyInstallLayout,
    resolveFirstPartyVersionRootIdentity,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { PUBLIC_RELEASE_RING_IDS } from '@happier-dev/release-runtime/releaseRings';

import {
    type BundledFirstPartyPluginSourceCustodyV1,
    type PluginSourceCustodyV1,
} from '@happier-dev/protocol';
import { isMachinePluginSourceCustody, type MachinePluginSourceCustody } from './sourceAuthority';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { resolveAuthoritativePackagedRuntimeCustody } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { resolvePublishedPinnedRunnerSnapshotById } from '@happier-dev/cli-common/pinnedRunnerSnapshot';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../projection/registry/sources/generatedBundledPluginManifests';
import { readPluginManifest } from '../manifest/read';
import { ingestCanonicalPluginManifest } from '../manifest/ingest';
import { readBundledPluginManifestInput } from '../projection/registry/builtIn/manifestFile';
import { createBundledActivationSourceResolver } from './bundledActivationSource';
import type { CanonicalPluginManifest } from '../manifest/types';
import type { PluginStorePaths } from '../store/paths';
import type { AgentSessionRunnerBindingV1 } from './runner/agentSessionRunnerFactoryBinding';
import { createAgentSessionRunnerFactoryBinding } from './runner/agentSessionRunnerFactoryBinding';
import { readRetainedBundledAgentFactory } from './retainedBundledAgentFactory';
import {
    assertContainedRegularGenerationFile,
    readPreparedImmutablePluginGeneration,
} from '../store/registry/generationStore';

export type RetainedBundledPluginRoot = Readonly<{
    rootPath: string;
    cacheIdentity: string;
}>;

/** Source-mode first-party declarations belong to the runner's tracked CLI assets. */
export function readRetainedFirstPartyDevelopmentManifest(params: Readonly<{ pluginId: string; runtimeRoot?: string }>): CanonicalPluginManifest {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === params.pluginId);
    if (!locator) throw new Error('Retained first-party development declaration is unavailable');
    const ingestion = ingestCanonicalPluginManifest(readBundledPluginManifestInput(locator, params.runtimeRoot), {
        purpose: 'installedRead',
        manifestAuthority: 'bundled_first_party', sourceProvenance: 'localSource',
    });
    if (!ingestion.ok || ingestion.manifest.id !== params.pluginId) {
        throw new Error('Retained first-party development declaration does not match its admitted plugin');
    }
    return ingestion.manifest;
}

/** Reuses the bundled source selector; a known id or repository containment is insufficient. */
export async function resolveRetainedFirstPartyDevelopmentRoot(params: Readonly<{ pluginId: string; repoRoot?: string }>): Promise<string | null> {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === params.pluginId);
    if (!locator?.daemonEntryPath || locator.sourceSpec.kind !== 'bundled') return null;
    let selectedRoot: string | null = null;
    const resolveSource = createBundledActivationSourceResolver({
        bundledPackageNames: [locator.daemonEntryPath],
        ...(params.repoRoot ? { repoRoot: params.repoRoot, canImportFirstPartyPluginSource: () => true } : {}),
        resolveDevelopmentSourceAuthority: ({ rootPath }) => { selectedRoot = rootPath; return null; },
    });
    resolveSource(locator);
    return selectedRoot ? await realpath(selectedRoot) : null;
}

function resolveRunnerPathSourceRoot(runnerSnapshotIdentity: string): string | null {
    if (!runnerSnapshotIdentity.startsWith('path:')) return null;
    const runtimeRoot = runnerSnapshotIdentity.slice('path:'.length);
    if (basename(runtimeRoot) !== 'cli' || basename(dirname(runtimeRoot)) !== 'apps') return null;
    return dirname(dirname(runtimeRoot));
}

/** Only bundled development leaves execute from the runner's source publication. */
export function isRunnerPinnedDevelopmentAgentSource(
    binding: Pick<AgentSessionRunnerBindingV1, 'pluginId' | 'sourceCustody'>,
): boolean {
    return binding.sourceCustody.kind === 'development'
        && BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.some(({ pluginId }) => pluginId === binding.pluginId);
}

/** A retained runner publication may supersede a daemon-current bootstrap source. */
export function runnerPinnedBundledCustodyCanSupersedeBootstrap(
    bootstrapCustody: PluginSourceCustodyV1,
    attestedCustody: PluginSourceCustodyV1,
): boolean {
    return bootstrapCustody.kind === 'bundled_first_party'
        && bootstrapCustody.packagedRuntime.kind === 'pinned_runner_snapshot'
        && attestedCustody.kind === 'bundled_first_party'
        && attestedCustody.packagedRuntime.kind === 'pinned_runner_snapshot';
}

/** Bundled dependencies execute from the same retained package root as their runner. */
export function selectRunnerManagedDependencySourceCustody(
    runnerCustody: MachinePluginSourceCustody,
    registeredCustody: MachinePluginSourceCustody,
): MachinePluginSourceCustody {
    return registeredCustody.kind === 'bundled_first_party'
        && runnerCustody.kind === 'bundled_first_party'
        ? runnerCustody
        : registeredCustody;
}

/** The runner's retained publication owns its first-party Agent declaration and version. */
export async function attestFreshRunnerAgentBinding(params: Readonly<{
    binding: AgentSessionRunnerBindingV1;
    paths: PluginStorePaths;
    runnerSnapshotIdentity: string;
    moduleUrl?: string;
}>): Promise<AgentSessionRunnerBindingV1> {
    const custody = params.binding.sourceCustody;
    const snapshotId = params.runnerSnapshotIdentity.startsWith('snapshot:')
        ? params.runnerSnapshotIdentity.slice('snapshot:'.length)
        : '';
    const isBundledFirstPartyDevelopmentSource = isRunnerPinnedDevelopmentAgentSource(params.binding);
    const isPinnedBundledSource = custody.kind === 'bundled_first_party'
        && custody.packagedRuntime.kind === 'pinned_runner_snapshot';
    if (!isBundledFirstPartyDevelopmentSource && !isPinnedBundledSource) {
        return params.binding;
    }
    if (!snapshotId || snapshotId.includes('/') || snapshotId.includes('\\')) {
        if (isBundledFirstPartyDevelopmentSource) {
            if (!params.runnerSnapshotIdentity.startsWith('path:')) return params.binding;
            const source = await attestRetainedPluginSource({
                paths: params.paths,
                pluginId: params.binding.pluginId,
                custody,
                manifestAuthority: 'bundled_first_party',
                runnerSnapshotIdentity: params.runnerSnapshotIdentity,
            });
            if (!source.manifest.contributes.agents.some(
                (agent) => agent.id === params.binding.localAgentId,
            )) {
                throw new Error('Runner Agent development source has no admitted Agent declaration');
            }
            if ('kind' in params.binding) {
                return Object.freeze({ ...params.binding, pluginVersion: source.manifest.version });
            }
            const factory = readRetainedBundledAgentFactory(source.manifest, params.binding.localAgentId);
            return createAgentSessionRunnerFactoryBinding({
                ...params.binding,
                pluginVersion: source.manifest.version,
                locator: factory.locator,
                normalizedModulePath: factory.normalizedModulePath,
                loadMode: factory.loadMode,
            });
        }
        throw new Error('Runner Agent bundled source has no pinned snapshot identity');
    }
    const runnerCustody = Object.freeze({
        kind: 'bundled_first_party' as const,
        packagedRuntime: Object.freeze({
            kind: 'pinned_runner_snapshot' as const,
            snapshotId,
        }),
    });
    const source = await attestRetainedPluginSource({
        paths: params.paths,
        pluginId: params.binding.pluginId,
        custody: runnerCustody,
        resolveBundledPluginRoot: (input) => resolveRetainedBundledPluginRoot({
            ...input,
            ...(params.moduleUrl ? { moduleUrl: params.moduleUrl } : {}),
        }),
    });
    if (!source.manifest.contributes.agents.some(
        (agent) => agent.id === params.binding.localAgentId,
    )) {
        throw new Error('Runner Agent bundled source has no admitted Agent declaration');
    }
    if ('kind' in params.binding) {
        return Object.freeze({
            ...params.binding,
            pluginVersion: source.manifest.version,
            sourceCustody: runnerCustody,
        });
    }
    const factory = readRetainedBundledAgentFactory(
        source.manifest,
        params.binding.localAgentId,
    );
    return createAgentSessionRunnerFactoryBinding({
        ...params.binding,
        pluginVersion: source.manifest.version,
        sourceCustody: runnerCustody,
        locator: factory.locator,
        normalizedModulePath: factory.normalizedModulePath,
        loadMode: factory.loadMode,
    });
}

export function retainedAgentSourceMatchesRunner(
    runnerSnapshotIdentity: string,
    binding: AgentSessionRunnerBindingV1,
): boolean {
    const custody = binding.sourceCustody;
    if (custody.kind === 'development') {
        // External development roots are attested by the current registry
        // occurrence; they do not live inside the host runner's source tree.
        if (!isRunnerPinnedDevelopmentAgentSource(binding)) return true;
        const sourceRoot = resolveRunnerPathSourceRoot(runnerSnapshotIdentity);
        return sourceRoot !== null
            && isCanonicalAbsolutePathInsideRoot(sourceRoot, custody.registeredRootId);
    }
    if (custody.kind !== 'bundled_first_party') return true;
    return custody.packagedRuntime.kind === 'pinned_runner_snapshot'
        ? runnerSnapshotIdentity === `snapshot:${custody.packagedRuntime.snapshotId}`
        : runnerSnapshotIdentity === `version:${custody.packagedRuntime.versionRootId}`;
}

/** A current registration supplies policy; the retained runner supplies its own attested code. */
export function currentAgentBindingMatchesRetainedRunner(params: Readonly<{
    runnerSnapshotIdentity: string;
    currentBinding: AgentSessionRunnerBindingV1;
    retainedBinding: AgentSessionRunnerBindingV1;
}>): boolean {
    if (!retainedAgentSourceMatchesRunner(
        params.runnerSnapshotIdentity,
        params.retainedBinding,
    )) return false;
    const currentCustody = params.currentBinding.sourceCustody;
    const retainedCustody = params.retainedBinding.sourceCustody;
    if ((currentCustody.kind === 'bundled_first_party' && retainedCustody.kind === 'bundled_first_party')
        || isRunnerPinnedDevelopmentAgentSource(params.retainedBinding)) {
        return params.currentBinding.pluginId === params.retainedBinding.pluginId
            && params.currentBinding.agentId === params.retainedBinding.agentId
            && params.currentBinding.localAgentId === params.retainedBinding.localAgentId;
    }
    return isDeepStrictEqual(params.currentBinding, params.retainedBinding);
}

export async function resolveRetainedBundledPluginRoot(params: Readonly<{
    pluginId: string;
    custody: BundledFirstPartyPluginSourceCustodyV1;
    moduleUrl?: string;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<RetainedBundledPluginRoot> {
    const moduleUrl = params.moduleUrl ?? import.meta.url;
    const packagedRuntime = params.custody.packagedRuntime;
    if (packagedRuntime.kind !== 'pinned_runner_snapshot' && packagedRuntime.kind !== 'cli_version_root') {
        throw new Error('Retained bundled source custody does not establish a Machine executable runtime');
    }
    const authoritativeRuntime = resolveAuthoritativePackagedRuntimeCustody({
        moduleUrl,
        ...(params.processEnv ? { processEnv: params.processEnv } : {}),
    });
    const expectedIdentity = packagedRuntime.kind === 'pinned_runner_snapshot'
        ? packagedRuntime.snapshotId
        : packagedRuntime.versionRootId;
    if (!authoritativeRuntime) {
        throw new Error('Retained bundled source custody does not match the executing packaged runtime');
    }
    let runtimeRoot = authoritativeRuntime.root;
    if (packagedRuntime.kind === 'pinned_runner_snapshot') {
        if (authoritativeRuntime.packagedRuntime.kind !== 'pinned_runner_snapshot') {
            throw new Error('Retained bundled runner snapshot has no authoritative snapshot store');
        }
        const snapshotsDir = dirname(await realpath(authoritativeRuntime.root));
        const location = resolvePublishedPinnedRunnerSnapshotById(
            join(authoritativeRuntime.root, 'package-dist', 'index.mjs'),
            packagedRuntime.snapshotId,
            { snapshotsDir },
        );
        if (!location || dirname(await realpath(location.snapshotRoot)) !== snapshotsDir) {
            throw new Error('Retained bundled runner snapshot is unavailable or untrusted');
        }
        runtimeRoot = location.snapshotRoot;
    } else {
        if (authoritativeRuntime.packagedRuntime.kind !== 'cli_version_root') {
            throw new Error('Retained bundled source custody does not match the executing packaged runtime');
        }
        const processEnv = params.processEnv ?? process.env;
        const retainedVersionRoot = PUBLIC_RELEASE_RING_IDS.flatMap((channel) => {
            const layout = resolveFirstPartyInstallLayout({
                componentId: 'happier-cli',
                channel,
                processEnv,
            });
            try {
                resolveFirstPartyVersionRootIdentity({
                    layout,
                    runtimeRoot: authoritativeRuntime.root,
                });
                return [resolveFirstPartyVersionRootIdentity({
                    layout,
                    runtimeRoot: join(layout.versionsDir, packagedRuntime.versionRootId),
                }).root];
            } catch {
                return [];
            }
        })[0];
        if (!retainedVersionRoot) {
            throw new Error('Retained bundled source custody does not match an available packaged version root');
        }
        runtimeRoot = retainedVersionRoot;
    }
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
        (candidate) => candidate.pluginId === params.pluginId,
    );
    if (!locator || locator.sourceSpec.kind !== 'bundled' || !locator.sourceSpec.locator.trim()) {
        throw new Error('Retained bundled source custody names an unknown first-party plugin');
    }
    const packageRoot = await realpath(join(
        runtimeRoot,
        'node_modules',
        ...locator.sourceSpec.locator.split('/'),
    ));
    const canonicalRuntimeRoot = await realpath(runtimeRoot);
    if (!isCanonicalAbsolutePathInsideRoot(canonicalRuntimeRoot, packageRoot)) {
        throw new Error('Retained bundled plugin root escapes its packaged runtime custody');
    }
    return Object.freeze({
        rootPath: packageRoot,
        cacheIdentity: `${packagedRuntime.kind}:${expectedIdentity}`,
    });
}

export type RetainedPluginSourceAttestation = Readonly<{
    rootPath: string;
    cacheIdentity: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    manifest: Extract<
        Awaited<ReturnType<typeof readPluginManifest>>,
        Readonly<{ ok: true }>
    >['manifest'];
    managedGeneration: Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>> | null;
    assertStillAvailable(): Promise<void>;
}>;

/** Attests restart-stable managed or first-party runner custody without interpreting a contribution family. */
export async function attestRetainedPluginSource(params: Readonly<{
    paths: PluginStorePaths;
    pluginId: string;
    custody: PluginSourceCustodyV1;
    manifestAuthority?: 'external' | 'bundled_first_party';
    runnerSnapshotIdentity?: string;
    resolveBundledPluginRoot?: typeof resolveRetainedBundledPluginRoot;
}>): Promise<RetainedPluginSourceAttestation> {
    if (!isMachinePluginSourceCustody(params.custody)) {
        throw new Error('Retained plugin custody does not establish a Machine executable source');
    }
    const custody = params.custody;
    const generation = custody.kind === 'managed'
        ? await readPreparedImmutablePluginGeneration({
            paths: params.paths,
            immutableGenerationId: custody.immutableGenerationId,
        })
        : null;
    if (generation && generation.record.pluginId !== params.pluginId) {
        throw new Error('Retained plugin source custody identity mismatch');
    }
    const bundledRoot = custody.kind === 'bundled_first_party'
        ? await (params.resolveBundledPluginRoot ?? resolveRetainedBundledPluginRoot)({
            pluginId: params.pluginId,
            custody: custody,
        })
        : null;
    const developmentRoot = custody.kind === 'development'
        ? await realpath(custody.registeredRootId)
        : null;
    const runnerSourceRoot = custody.kind === 'development'
        ? resolveRunnerPathSourceRoot(params.runnerSnapshotIdentity ?? '')
        : null;
    if (developmentRoot) {
        const canonicalRunnerSourceRoot = runnerSourceRoot ? await realpath(runnerSourceRoot) : null;
        const expectedPluginRoot = canonicalRunnerSourceRoot
            ? await resolveRetainedFirstPartyDevelopmentRoot({ pluginId: params.pluginId, repoRoot: canonicalRunnerSourceRoot }) : null;
        if (!canonicalRunnerSourceRoot
            || params.manifestAuthority !== 'bundled_first_party'
            || expectedPluginRoot !== developmentRoot
            || !isCanonicalAbsolutePathInsideRoot(canonicalRunnerSourceRoot, developmentRoot)) {
            throw new Error('Retained first-party development source does not belong to the runner path');
        }
    }
    if (generation) {
        await assertContainedRegularGenerationFile(
            generation.rootPath,
            generation.record.manifestRelativePath,
            'Retained plugin generation manifest',
        );
    }
    const rootPath = await realpath(generation?.rootPath ?? bundledRoot?.rootPath ?? developmentRoot!);
    const manifestAuthority = custody.kind === 'bundled_first_party' || custody.kind === 'development'
        ? 'bundled_first_party' as const
        : params.manifestAuthority ?? 'external' as const;
    const manifest = developmentRoot && runnerSourceRoot
        ? { ok: true as const, manifest: readRetainedFirstPartyDevelopmentManifest({
            pluginId: params.pluginId, runtimeRoot: join(runnerSourceRoot, 'apps', 'cli'),
        }) }
        : await readPluginManifest({
        purpose: 'installedRead',
        manifestPath: generation
            ? join(rootPath, ...generation.record.manifestRelativePath.split('/'))
            : join(rootPath, '.happier-plugin', 'plugin.json'),
        manifestAuthority,
        sourceProvenance: generation?.record.sourceProvenance ?? 'localSource',
    });
    if (!manifest.ok || manifest.manifest.id !== params.pluginId) {
        throw new Error('Retained plugin immutable declaration source mismatch');
    }
    return Object.freeze({
        rootPath,
        cacheIdentity: generation
            ? `managed:${generation.record.immutableGenerationId}`
            : bundledRoot?.cacheIdentity ?? `development:${params.runnerSnapshotIdentity}:${rootPath}`,
        manifestAuthority,
        manifest: manifest.manifest,
        managedGeneration: generation,
        assertStillAvailable: async () => {
            if (custody.kind === 'managed') {
                const current = await readPreparedImmutablePluginGeneration({
                    paths: params.paths,
                    immutableGenerationId: custody.immutableGenerationId,
                });
                if (current.record.pluginId !== params.pluginId) {
                    throw new Error('Retained plugin source custody identity changed during attestation');
                }
                return;
            }
            if (custody.kind === 'development') {
                const currentRoot = await realpath(custody.registeredRootId);
                const currentRunnerSourceRoot = resolveRunnerPathSourceRoot(params.runnerSnapshotIdentity ?? '');
                if (!currentRunnerSourceRoot
                    || currentRoot !== rootPath
                    || await resolveRetainedFirstPartyDevelopmentRoot({ pluginId: params.pluginId, repoRoot: currentRunnerSourceRoot }) !== currentRoot
                    || !isCanonicalAbsolutePathInsideRoot(await realpath(currentRunnerSourceRoot), currentRoot)) {
                    throw new Error('Retained first-party development source changed during attestation');
                }
                return;
            }
            const resolved = await (params.resolveBundledPluginRoot ?? resolveRetainedBundledPluginRoot)({
                pluginId: params.pluginId, custody: custody,
            });
            if (
                resolved.cacheIdentity !== bundledRoot!.cacheIdentity
                || await realpath(resolved.rootPath) !== rootPath
            ) {
                throw new Error('Retained bundled source custody changed during attestation');
            }
        },
    });
}
