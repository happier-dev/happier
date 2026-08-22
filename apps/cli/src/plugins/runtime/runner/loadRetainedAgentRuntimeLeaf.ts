import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    isReservedHappierPluginId,
    type PluginAgentAcpTransport,
} from '@happier-dev/protocol';

import type { PluginStorePaths } from '../../store/paths';
import { readPluginManifest } from '../../manifest/read';
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
                attested.transport,
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
        transport: PluginAgentAcpTransport;
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
    const manifestAuthority = hostDeclarativeAcpBinding
        ? (
            isReservedHappierPluginId(binding.pluginId)
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
            agentId: declaredAgent.id,
            qualifiedAgentId:
                `${manifest.manifest.id}/agents/${declaredAgent.id}`,
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
            transport: runtime.transport,
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
