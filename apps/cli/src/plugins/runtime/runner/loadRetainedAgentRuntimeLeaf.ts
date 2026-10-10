import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
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
import { loadVerifiedPluginModule } from '../loadPluginModule';
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
    resolveRetainedBundledPluginRoot,
} from '../retainedPluginSourceAttestation';
import { readRetainedBundledAgentFactory } from '../retainedBundledAgentFactory';
import { createBundledActivationSourceResolver } from '../bundledActivationSource';
import { BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS } from '../../projection/registry/sources/generatedBundledPluginManifests';

async function readDevelopmentManifestAuthority(
    pluginId: string,
    registeredRoot: string,
): Promise<'external' | 'bundled_first_party'> {
    const locator = BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.find(
        (candidate) => candidate.pluginId === pluginId,
    );
    if (!locator?.daemonEntryPath || locator.sourceSpec.kind !== 'bundled') return 'external';
    let selectedRoot: string | null = null;
    const resolveSource = createBundledActivationSourceResolver({
        bundledPackageNames: [locator.daemonEntryPath],
        resolveDevelopmentSourceAuthority: ({ rootPath }) => {
            selectedRoot = rootPath;
            return null;
        },
    });
    // Reuse the daemon's root selection without loading or activating its code.
    // A reserved plugin id alone does not establish first-party authority.
    resolveSource(locator);
    return selectedRoot && await realpath(selectedRoot) === registeredRoot
        ? 'bundled_first_party'
        : 'external';
}
export type RetainedAgentRuntimeLeaf = Readonly<{
    factory: AgentRuntimeFactory;
    externalSessions?: AgentExternalSessionsContribution;
}>;

export async function loadRetainedAgentRuntimeLeaf(params: Readonly<{
    paths: PluginStorePaths;
    binding: unknown;
    developmentOccurrenceId?: string;
    resolveBundledPluginRoot?: typeof resolveRetainedBundledPluginRoot;
}>): Promise<RetainedAgentRuntimeLeaf> {
    const attested = await verifyRunnerAgentBindingAgainstGeneration(
        params,
    );
    if (attested.bindingKind === 'host_declarative_acp_v1') {
        return Object.freeze({
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
        return Object.freeze({
            factory: factory as AgentRuntimeFactory,
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
    return Object.freeze({
        factory: factory as AgentRuntimeFactory,
        externalSessions: externalSessionsSnapshot,
    });
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
    ) {
        throw new Error(
            'Development retained Agent binding requires a daemon-attested current occurrence',
        );
    }
    const retainedSource = binding.sourceCustody.kind === 'development'
        ? null
        : await attestRetainedPluginSource({
            paths: params.paths,
            pluginId: binding.pluginId,
            custody: binding.sourceCustody,
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
        : await readPluginManifest({
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
