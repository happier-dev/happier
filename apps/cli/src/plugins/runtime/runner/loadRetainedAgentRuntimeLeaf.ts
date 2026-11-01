import { lstat, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    normalizePluginDeclarativeAcpRuntime,
} from '@/agent/acp/runtime/definition/plugin';

import type { PluginStorePaths } from '../../store/paths';
import { readPluginManifest } from '../../manifest/read';
import {
    resolveAgentContributionQualifiedId,
    resolveContributedAgentRoutingId,
} from '../../projection/registry/agentRoutingIdentity';
import {
    snapshotAgentExternalSessionsThroughRegistrationScope,
} from '../api/registrationRightsHost';
import {
    assertContainedRegularGenerationFile,
    readValidatedAgentSessionRunnerFactories,
} from '../../store/registry/generationStore';
import { loadVerifiedPluginModule, type PluginModuleNamespace } from '../loadPluginModule';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { projectManifestAgentContribution } from '../../projection/registry/projectManifestAgentContribution';
import { projectAgentConnectedAccountLaunchCatalogEntry, projectAgentExperimentalVendorResumeSupportCatalogEntry } from '../../projection/registry/agentCatalogEntryHooks';
import { activateContributionModule } from '../lifecycle/activation/activateContributionModule';
import { resolvePluginAuthorStagingModule } from '../../authoring/sourceModule';
import {
    createAgentSessionRunnerFactoryBinding,
    createHostDeclarativeAcpRunnerBinding,
    verifyAgentSessionRunnerBindingV1,
    type AgentSessionRunnerBindingV1,
} from './agentSessionRunnerFactoryBinding';
import {
    readAgentPrimaryRuntime,
    readAgentSessionCapabilities,
} from '../../projection/registry/agentContributionDefinition';
import {
    createHostDeclarativeAcpAgentRuntimeFactory,
} from './createHostDeclarativeAcpAgentRuntimeFactory';
import {
    attestRetainedPluginSource,
    readRetainedFirstPartyDevelopmentManifest,
    resolveRetainedFirstPartyDevelopmentRoot,
    resolveRetainedBundledPluginRoot,
} from '../retainedPluginSourceAttestation';
import { readRetainedBundledAgentFactory } from '../retainedBundledAgentFactory';
import { createBundledActivationSourceResolver } from '../bundledActivationSource';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../projection/registry/sources/generatedBundledPluginManifests';

async function readDevelopmentManifestAuthority(
    pluginId: string,
    registeredRoot: string,
): Promise<'external' | 'bundled_first_party'> {
    return await resolveRetainedFirstPartyDevelopmentRoot({ pluginId }) === registeredRoot
        ? 'bundled_first_party'
        : 'external';
}
export type RetainedAgentRuntimeLeaf = Readonly<{
    factory: AgentRuntimeFactory;
    externalSessions?: AgentExternalSessionsContribution;
    catalogEntry: AgentCatalogEntry | null;
    dispose(): Promise<void>;
}>;

/** Source proof shared by daemon services after exact runner admission. */
export type RetainedRunnerAgentServiceBinding = Pick<
    Awaited<ReturnType<typeof verifyRunnerAgentBindingAgainstGeneration>>,
    'binding' | 'manifest' | 'assertStillAvailable'
>;

export async function loadRetainedAgentRuntimeLeaf(params: Readonly<{
    paths: PluginStorePaths;
    binding: unknown;
    developmentOccurrenceId?: string;
    developmentRunnerSnapshotIdentity?: string;
    resolveBundledPluginRoot?: typeof resolveRetainedBundledPluginRoot;
}>): Promise<RetainedAgentRuntimeLeaf> {
    const attested = await verifyRunnerAgentBindingAgainstGeneration(
        params,
    );
    const declaredEntry = projectManifestAgentContribution({
        definition: attested.declaredAgent,
        provenance: attested.manifestAuthority === 'bundled_first_party' ? 'first_party' : 'external',
        source: { kind: attested.manifestAuthority === 'bundled_first_party' ? 'bundled' : 'package' },
        pluginId: attested.manifest.id,
        systemTools: attested.manifest.contributes.systemTools,
        hostAccess: attested.manifest.hostAccess,
    }).catalogEntry ?? null;
    if (attested.bindingKind === 'host_declarative_acp_v1') {
        return Object.freeze({
            catalogEntry: declaredEntry,
            dispose: async () => {},
            factory: createHostDeclarativeAcpAgentRuntimeFactory(
                normalizePluginDeclarativeAcpRuntime(attested.runtime),
                {
                    executionRunContextV1: readAgentSessionCapabilities(
                        attested.declaredAgent,
                    )?.executionRunContext?.versions[0] === 1,
                },
            ),
        });
    }
    const { binding, fact } = attested;
    const sourceRootPath = await realpath(attested.rootPath);
    if (attested.sourceKind === 'managed') {
        await assertContainedRegularGenerationFile(
            sourceRootPath,
            fact.normalizedModulePath,
            'Runner Agent factory module',
        );
    } else {
        const lexicalPath = join(sourceRootPath, ...fact.normalizedModulePath.split('/'));
        const facts = await lstat(lexicalPath);
        if (!facts.isFile() || facts.isSymbolicLink()) {
            throw new Error('Runner Agent factory module must be a contained regular file');
        }
    }
    const modulePath = await realpath(join(
        sourceRootPath,
        ...fact.normalizedModulePath.split('/'),
    ));
    if (
        modulePath === sourceRootPath
        || !isCanonicalAbsolutePathInsideRoot(sourceRootPath, modulePath)
    ) {
        throw new Error('Runner Agent factory module escapes its retained source custody');
    }
    const moduleNamespace = await loadVerifiedPluginModule({
        entryPath: modulePath,
        loadMode: fact.loadMode,
        generationScope: binding,
        cacheKey: `${attested.cacheIdentity}:${fact.normalizedModulePath}`,
        nativeFileUrlMode: 'canonical',
    });
    await attested.assertStillAvailable();
    const factory = Object.prototype.hasOwnProperty.call(
        moduleNamespace,
        fact.locator.export,
    )
        ? moduleNamespace[fact.locator.export]
        : undefined;
    if (typeof factory !== 'function') {
        throw new Error('Runner Agent factory export is missing or not callable');
    }
    if (fact.locator.externalSessionsExport === undefined) {
        const catalog = await projectRetainedAgentCatalogEntry({
            attested, declaredEntry, factory: factory as AgentRuntimeFactory,
        });
        return Object.freeze({
            factory: factory as AgentRuntimeFactory,
            ...catalog,
        });
    }
    const externalSessions = Object.prototype.hasOwnProperty.call(
        moduleNamespace,
        fact.locator.externalSessionsExport,
    )
        ? moduleNamespace[fact.locator.externalSessionsExport]
        : undefined;
    if (externalSessions === undefined) {
        throw new Error('External Sessions companion export is missing');
    }
    const externalSessionsSnapshot =
        snapshotAgentExternalSessionsThroughRegistrationScope({
            pluginId: binding.pluginId,
            localAgentId: binding.localAgentId,
            contribution: externalSessions,
        });
    const catalog = await projectRetainedAgentCatalogEntry({
        attested, declaredEntry, factory: factory as AgentRuntimeFactory,
    });
    return Object.freeze({
        factory: factory as AgentRuntimeFactory,
        externalSessions: externalSessionsSnapshot,
        ...catalog,
    });
}

/** The retained source owns static launch facts, independently of the current daemon. */
async function projectRetainedAgentCatalogEntry(input: Readonly<{
    attested: Awaited<ReturnType<typeof verifyRunnerAgentBindingAgainstGeneration>>;
    declaredEntry: AgentCatalogEntry | null;
    factory: AgentRuntimeFactory;
}>): Promise<Pick<RetainedAgentRuntimeLeaf, 'catalogEntry' | 'dispose'>> {
    const { attested, declaredEntry } = input;
    if (!declaredEntry || (!attested.declaredAgent.connectedAccounts?.length
        && declaredEntry.vendorResumeSupport !== 'experimental')
        || attested.bindingKind !== 'plugin_factory_v1') return { catalogEntry: declaredEntry, dispose: async () => {} };
    const rootPath = await realpath(attested.rootPath);
    const loadModule = async (entryPath: string, loadMode = attested.fact.loadMode) => {
        const normalizedPath = relative(rootPath, resolve(entryPath)).split(sep).join('/');
        if (attested.sourceKind === 'managed') {
            await assertContainedRegularGenerationFile(rootPath, normalizedPath, 'Retained Agent catalog module');
        } else {
            const facts = await lstat(entryPath);
            if (!facts.isFile() || facts.isSymbolicLink()
                || !isCanonicalAbsolutePathInsideRoot(rootPath, await realpath(entryPath))) {
                throw new Error('Retained Agent catalog module escapes its source custody');
            }
        }
        return await loadVerifiedPluginModule({
            entryPath, loadMode, generationScope: attested.binding,
            cacheKey: `${attested.cacheIdentity}:${normalizedPath}`, nativeFileUrlMode: 'canonical',
        });
    };
    const daemonEntrypoint = attested.manifest.entrypoints?.daemon;
    if (!daemonEntrypoint) throw new Error('Retained Agent catalog has no activation entrypoint');
    const entryPath = resolve(rootPath, daemonEntrypoint);
    let moduleNamespace: PluginModuleNamespace;
    let resolveRelativeModule: NonNullable<Parameters<typeof activateContributionModule>[0]['resolveRelativeModule']>;
    if (attested.sourceKind === 'development' && attested.manifestAuthority === 'bundled_first_party') {
        const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(candidate => candidate.pluginId === attested.binding.pluginId);
        if (!locator?.daemonEntryPath) throw new Error('Retained development Agent catalog has no bundled locator');
        const source = createBundledActivationSourceResolver({
            bundledPackageNames: [locator.daemonEntryPath],
            importModule: async (specifier, selection) => await loadModule(fileURLToPath(specifier), selection.loadMode),
            resolveDevelopmentSourceAuthority: ({ rootPath: selectedRoot }) => {
                if (realpathSync(selectedRoot) !== rootPath) {
                    throw new Error('Retained Agent catalog selected a foreign development root');
                }
                // Execution custody was already attested by this retained owner.
                return null;
            },
        })(locator);
        if (!source) throw new Error('Retained development Agent catalog source is unavailable');
        moduleNamespace = await source.load();
        resolveRelativeModule = source.resolveRelativeModule;
    } else {
        moduleNamespace = await loadModule(entryPath);
        resolveRelativeModule = async module => {
            const resolved = await resolvePluginAuthorStagingModule({
                graph: { rootPath, entryPath, loadModule }, module,
            });
            return { ...resolved, loadMode: attested.fact.loadMode };
        };
    }
    const activation = await activateContributionModule({
        pluginId: attested.binding.pluginId, manifestAuthority: attested.manifestAuthority,
        occurrenceId: attested.cacheIdentity, manifest: attested.manifest,
        moduleNamespace, resolveRelativeModule, isOccurrenceCurrent: () => true,
    });
    try {
        await attested.assertStillAvailable();
        const registration = activation.registrations.find(candidate => candidate.family === 'agents'
            && candidate.localId === attested.binding.localAgentId);
        if (activation.status !== 'active' || registration?.family !== 'agents'
            || registration.value.factory !== input.factory
            || !isDeepStrictEqual(registration.value.sessionRunnerFactory, attested.fact.locator)) {
            throw new Error('Retained Agent catalog does not match its attested factory module');
        }
        let disposed = false;
        const launch = registration.value.connectedAccountLaunch;
        const projected = launch ? projectAgentConnectedAccountLaunchCatalogEntry({
            pluginId: attested.binding.pluginId, agentId: declaredEntry.id,
            connectedAccountLaunch: launch, hostAccess: attested.manifest.hostAccess, isCurrent: () => true,
        }) : null;
        return Object.freeze({
            catalogEntry: Object.freeze({ ...declaredEntry,
                ...(registration.value.vendorResumeSupport
                    ? projectAgentExperimentalVendorResumeSupportCatalogEntry({
                        vendorResumeSupport: registration.value.vendorResumeSupport,
                        isCurrent: () => !disposed,
                    }) : {}),
                ...(projected ? {
                    connectedAccountNativeHome: projected.connectedAccountNativeHome,
                    getConnectedServiceStateSharingDescriptor: projected.getConnectedServiceStateSharingDescriptor,
                    connectedAccountRequestAuthUses: projected.connectedAccountRequestAuthUses,
                    connectedAccountFileEnvironmentUses: projected.connectedAccountFileEnvironmentUses,
                    connectedAccountEnvironmentUses: projected.connectedAccountEnvironmentUses,
                    connectedAccountEnvironmentUnsetUses: projected.connectedAccountEnvironmentUnsetUses,
                } : {}),
            }),
            async dispose() {
                if (disposed) return;
                disposed = true;
                await activation.dispose();
            },
        });
    } catch (error) {
        await activation.dispose();
        throw error;
    }
}

type ValidatedRunnerFactories = Awaited<
    ReturnType<typeof readValidatedAgentSessionRunnerFactories>
>;

async function readOptionalValidatedRunnerFactories(input: Readonly<{
    paths: PluginStorePaths;
    record: Parameters<
        typeof readValidatedAgentSessionRunnerFactories
    >[0]['record'];
}>): Promise<ValidatedRunnerFactories | null> {
    try {
        return await readValidatedAgentSessionRunnerFactories(input);
    } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export async function verifyRunnerAgentBindingAgainstGeneration(
    params: Readonly<{
        paths: PluginStorePaths;
        binding: unknown;
        developmentOccurrenceId?: string;
        developmentRunnerSnapshotIdentity?: string;
        resolveBundledPluginRoot?: typeof resolveRetainedBundledPluginRoot;
    }>,
): Promise<Readonly<{
    binding: AgentSessionRunnerBindingV1;
    sourceKind: 'managed' | 'bundled_first_party' | 'development';
    rootPath: string;
    cacheIdentity: string;
    assertStillAvailable(): Promise<void>;
    manifest: Extract<
        Awaited<ReturnType<typeof readPluginManifest>>,
        Readonly<{ ok: true }>
    >['manifest'];
    manifestAuthority: 'external' | 'bundled_first_party';
    declaredAgent: NonNullable<
        Extract<
            Awaited<ReturnType<typeof readPluginManifest>>,
            Readonly<{ ok: true }>
        >['manifest']['contributes']['agents'][number]
    >;
} & (
    | Readonly<{
        bindingKind: 'plugin_factory_v1';
        fact: ValidatedRunnerFactories['factories'][number];
    }>
    | Readonly<{
        bindingKind: 'host_declarative_acp_v1';
        runtime: unknown;
    }>
)>> {
    const binding = verifyAgentSessionRunnerBindingV1(params.binding);
    if (
        binding.sourceCustody.kind === 'development'
        && !params.developmentOccurrenceId?.trim()
        && !params.developmentRunnerSnapshotIdentity?.trim()
    ) {
        throw new Error(
            'Development retained Agent binding requires a daemon-attested current occurrence',
        );
    }
    const retainedSource = binding.sourceCustody.kind === 'development'
        && !params.developmentRunnerSnapshotIdentity
        ? null
        : await attestRetainedPluginSource({
            paths: params.paths,
            pluginId: binding.pluginId,
            custody: binding.sourceCustody,
            ...(params.developmentRunnerSnapshotIdentity
                ? {
                    manifestAuthority: 'bundled_first_party' as const,
                    runnerSnapshotIdentity: params.developmentRunnerSnapshotIdentity,
                }
                : {}),
            ...(params.resolveBundledPluginRoot
                ? { resolveBundledPluginRoot: params.resolveBundledPluginRoot }
                : {}),
        });
    const generation = retainedSource?.managedGeneration ?? null;
    const developmentCustody = binding.sourceCustody.kind === 'development'
        ? binding.sourceCustody
        : null;
    const developmentRoot = developmentCustody
        ? await realpath(developmentCustody.registeredRootId)
        : null;
    if (
        developmentRoot
        && developmentRoot !== developmentCustody?.registeredRootId
    ) {
        throw new Error(
            'Runner development source custody no longer names its canonical registered root',
        );
    }
    const rootPath = retainedSource?.rootPath ?? developmentRoot!;
    const validated = generation
        ? await readOptionalValidatedRunnerFactories({
            paths: params.paths,
            record: generation.record,
        })
        : null;
    const hostDeclarativeAcpBinding = 'kind' in binding;
    const manifestAuthority = retainedSource?.manifestAuthority
        ?? validated?.manifestAuthority
        ?? (developmentRoot
            ? await readDevelopmentManifestAuthority(binding.pluginId, developmentRoot)
            : 'external' as const);
    if (!manifestAuthority) {
        throw new Error(
            'Runner Agent binding names an unvalidated Agent factory',
        );
    }
    if (
        hostDeclarativeAcpBinding
        && validated
        && (
            validated.manifestAuthority !== manifestAuthority
            || validated.factories.some(
                (candidate) => candidate.localAgentId
                    === binding.localAgentId,
            )
        )
    ) {
        throw new Error(
            'Host declarative ACP runner binding conflicts with a plugin factory',
        );
    }
    const manifest = retainedSource
        ? Object.freeze({ ok: true as const, manifest: retainedSource.manifest })
        : developmentRoot && manifestAuthority === 'bundled_first_party'
            ? { ok: true as const, manifest: readRetainedFirstPartyDevelopmentManifest({ pluginId: binding.pluginId }) }
        : await readPluginManifest({
            purpose: 'installedRead',
            manifestPath: join(rootPath, '.happier-plugin', 'plugin.json'),
            manifestAuthority,
            sourceProvenance: 'localSource',
        });
    const declaredAgent = manifest.ok
        ? manifest.manifest.contributes.agents.find(
            (candidate) => candidate.id
                === binding.localAgentId,
        )
        : undefined;
    if (
        !manifest.ok
        || manifest.manifest.id !== binding.pluginId
        || manifest.manifest.version !== binding.pluginVersion
        || !declaredAgent
    ) {
        throw new Error(
            'Runner Agent binding immutable declaration source mismatch',
        );
    }
    if (hostDeclarativeAcpBinding) {
        const runtime = readAgentPrimaryRuntime(declaredAgent);
        if (
            runtime?.kind !== 'acp'
            || !readAgentSessionCapabilities(declaredAgent)
        ) {
            throw new Error(
                'Host declarative ACP runner binding names an ineligible immutable declaration',
            );
        }
        const expectedAgentIdentity = Object.freeze({
            // The two qualified facts are distinct and must not be re-derived
            // from each other: `agentId` is the canonical host routing id
            // (unqualified for bundled first-party Agents), while
            // `qualifiedAgentId` is the always-qualified contribution key
            // used for activation and managed-service authority.
            // `localAgentId` stays the manifest-local id for factory
            // construction. `pluginId` + `localAgentId` carry the durable
            // identity in structured form alongside both spellings.
            agentId: resolveContributedAgentRoutingId({
                pluginId: manifest.manifest.id,
                localId: declaredAgent.id,
                provenance: manifestAuthority === 'bundled_first_party'
                    ? 'first_party'
                    : 'external',
            }),
            qualifiedAgentId: resolveAgentContributionQualifiedId({
                pluginId: manifest.manifest.id,
                localId: declaredAgent.id,
            }),
            localAgentId: declaredAgent.id,
        });
        const expectedBinding = createHostDeclarativeAcpRunnerBinding({
            kind: 'host_declarative_acp_v1',
            v: 1,
            pluginId: manifest.manifest.id,
            pluginVersion: manifest.manifest.version,
            ...expectedAgentIdentity,
            sourceCustody: binding.sourceCustody,
        });
        if (!isDeepStrictEqual(expectedBinding, binding)) {
            throw new Error(
                'Host declarative ACP runner binding is not generation-attested',
            );
        }
        return Object.freeze({
            bindingKind: 'host_declarative_acp_v1' as const,
            binding,
            sourceKind: binding.sourceCustody.kind,
            rootPath,
            cacheIdentity: retainedSource?.cacheIdentity
                ?? `development:${params.developmentOccurrenceId}`,
            assertStillAvailable: async () => {
                if (retainedSource) {
                    await retainedSource.assertStillAvailable();
                    return;
                }
                if (
                    binding.sourceCustody.kind !== 'development'
                    || await realpath(binding.sourceCustody.registeredRootId) !== rootPath
                ) {
                    throw new Error('Runner development source custody changed during attestation');
                }
            },
            manifest: manifest.manifest,
            manifestAuthority,
            declaredAgent,
            runtime,
        });
    }
    const fact = binding.sourceCustody.kind === 'bundled_first_party'
        ? readRetainedBundledAgentFactory(manifest.manifest, binding.localAgentId)
        : validated?.factories.find(
        (candidate) => candidate.localAgentId === binding.localAgentId,
    ) ?? (binding.sourceCustody.kind === 'development'
        ? Object.freeze({
            localAgentId: binding.localAgentId,
            locator: binding.locator,
            normalizedModulePath: binding.normalizedModulePath,
            loadMode: binding.loadMode,
        })
        : undefined);
    if (!fact) {
        throw new Error(
            'Runner Agent binding names an unvalidated Agent factory',
        );
    }
    const expectedBinding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: binding.pluginId,
        pluginVersion: binding.pluginVersion,
        agentId: binding.agentId,
        localAgentId: fact.localAgentId,
        sourceCustody: binding.sourceCustody,
        locator: fact.locator,
        normalizedModulePath: fact.normalizedModulePath,
        loadMode: fact.loadMode,
    });
    if (!isDeepStrictEqual(expectedBinding, binding)) {
        throw new Error(
            'Runner Agent factory binding is not generation-attested',
        );
    }
    return Object.freeze({
        bindingKind: 'plugin_factory_v1' as const,
        binding,
        sourceKind: binding.sourceCustody.kind,
        rootPath,
        cacheIdentity: retainedSource?.cacheIdentity
            ?? `development:${params.developmentOccurrenceId}`,
        assertStillAvailable: async () => {
            if (retainedSource) {
                await retainedSource.assertStillAvailable();
                return;
            }
            if (
                binding.sourceCustody.kind !== 'development'
                || await realpath(binding.sourceCustody.registeredRootId) !== rootPath
            ) {
                throw new Error('Runner development source custody changed during attestation');
            }
        },
        fact,
        manifest: manifest.manifest,
        manifestAuthority,
        declaredAgent,
    });
}
