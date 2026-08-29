import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';

import {
    normalizePluginDeclarativeAcpRuntime,
} from '@/agent/acp/runtime/definition/plugin';
import {
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
} from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { resolveBundledImmutablePluginArtifact } from '../../store/registry/generationStore';

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
    readPreparedImmutablePluginGeneration,
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
export type RetainedAgentRuntimeLeaf = Readonly<{
    factory: AgentRuntimeFactory;
    externalSessions?: AgentExternalSessionsContribution;
}>;

export async function loadRetainedAgentRuntimeLeaf(params: Readonly<{
    paths: PluginStorePaths;
    binding: unknown;
}>): Promise<RetainedAgentRuntimeLeaf> {
    const attested = await verifyRunnerAgentBindingAgainstGeneration(
        params,
    );
    if (attested.bindingKind === 'host_declarative_acp_v1') {
        return Object.freeze({
            factory: createHostDeclarativeAcpAgentRuntimeFactory(
                normalizePluginDeclarativeAcpRuntime(attested.runtime),
            ),
        });
    }
    const { binding, generation, fact } = attested;
    const generationRootPath = await realpath(generation.rootPath);
    await assertContainedRegularGenerationFile(
        generationRootPath,
        fact.normalizedModulePath,
        'Runner Agent factory module',
    );
    const modulePath = await realpath(join(
        generationRootPath,
        ...fact.normalizedModulePath.split('/'),
    ));
    const relativeModulePath = relative(generationRootPath, modulePath);
    if (
        modulePath === generationRootPath
        || !isCanonicalAbsolutePathInsideRoot(generationRootPath, modulePath)
    ) {
        throw new Error('Runner Agent factory module escapes its immutable generation');
    }
    const moduleNamespace = await loadVerifiedPluginModule({
        entryPath: modulePath,
        loadMode: fact.loadMode,
        generationScope: binding,
        cacheKey: `${binding.immutableGenerationId}:${fact.normalizedModulePath}`,
        nativeFileUrlMode: 'canonical',
    });
    await readPreparedImmutablePluginGeneration({
        paths: params.paths,
        immutableGenerationId:
            binding.immutableGenerationId,
    });
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
    }>,
): Promise<Readonly<{
    binding: AgentSessionRunnerBindingV1;
    generation: Awaited<ReturnType<
        typeof readPreparedImmutablePluginGeneration
    >>;
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
    const generation = await readPreparedImmutablePluginGeneration({
        paths: params.paths,
        immutableGenerationId: binding.immutableGenerationId,
    });
    if (generation.record.pluginId !== binding.pluginId) {
        throw new Error(
            'Runner Agent binding generation identity mismatch',
        );
    }
    const validated = await readOptionalValidatedRunnerFactories({
        paths: params.paths,
        record: generation.record,
    });
    const hostDeclarativeAcpBinding = 'kind' in binding;
    // First-party authority for a host-declarative binding comes from host
    // custody of this exact generation, never from the plugin's own id: an
    // installed plugin may legitimately carry a `happier.*` id while it is
    // developed from a local working tree, and this authority reaches the
    // managed-service invocation owner as `provenance: 'first_party'`.
    const manifestAuthority = hostDeclarativeAcpBinding
        ? (
            resolveBundledImmutablePluginArtifact({
                bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
                pluginId: binding.pluginId,
                immutableGenerationId: binding.immutableGenerationId,
            })
                ? 'bundled_first_party'
                : 'external'
        )
        : validated?.manifestAuthority;
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
    const manifest = await readPluginManifest({
        manifestPath: join(
            generation.rootPath,
            ...generation.record.manifestRelativePath.split('/'),
        ),
        manifestAuthority,
        sourceProvenance: generation.record.sourceProvenance,
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
            immutableGenerationId:
                generation.record.immutableGenerationId,
        });
        if (!isDeepStrictEqual(expectedBinding, binding)) {
            throw new Error(
                'Host declarative ACP runner binding is not generation-attested',
            );
        }
        return Object.freeze({
            bindingKind: 'host_declarative_acp_v1' as const,
            binding,
            generation,
            manifest: manifest.manifest,
            manifestAuthority,
            declaredAgent,
            runtime,
        });
    }
    const fact = validated?.factories.find(
        (candidate) => candidate.localAgentId
            === binding.localAgentId,
    );
    if (!validated || !fact) {
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
        immutableGenerationId: binding.immutableGenerationId,
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
        generation,
        fact,
        manifest: manifest.manifest,
        manifestAuthority,
        declaredAgent,
    });
}
