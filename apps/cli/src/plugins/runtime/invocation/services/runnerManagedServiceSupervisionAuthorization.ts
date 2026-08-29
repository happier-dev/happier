import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
    resolveProviderManagedRuntimeDeclarationV1,
    type ManagedExecutableRef,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    ManagedServiceSpec,
} from '@happier-dev/plugin-sdk/managed-services';

import type {
    RunnerDaemonManagedProviderBootstrapV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { readPluginManifest } from '@/plugins/manifest/read';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
import type { PluginStorePaths } from '@/plugins/store/paths';
import {
    readCurrentPluginImmutableGenerationIntegrityCurrentness,
    readPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import {
    resolveCurrentInstalledPluginGenerationRuntimeExecutable,
} from '@/plugins/runtime/installedGenerationRuntimeExecutable';
import {
    verifyRunnerAgentBindingAgainstGeneration,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import type {
    AgentSessionRunnerBindingV1,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import {
    projectManagedServiceSpawnEnvironmentKeys,
} from './managedServicesOwner';
import type { ResolvedPluginExecutable } from './exec';

export type RunnerManagedServiceSupervisionAuthorizationRequest = Readonly<{
    contributionId: string;
    operationClaimId?: string;
    serverId: string;
    immutableGenerationId: string;
    executable: ManagedExecutableRef;
    environmentKeys: readonly string[];
}>;

export type RunnerManagedProviderServerLaunchAuthority = Readonly<{
    serverId: string;
    executable: ManagedExecutableRef;
    environmentKeys: readonly string[];
}>;

type RunnerManagedAgentServiceSupervisionAuthorizationInput = Readonly<{
    paths: PluginStorePaths;
    binding: AgentSessionRunnerBindingV1;
    request: RunnerManagedServiceSupervisionAuthorizationRequest;
    processEnv?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
}>;

type RunnerManagedServiceSupervisionAuthorization = Readonly<{
    launch:
        | Readonly<{
            kind: 'daemonResolved';
            value: ResolvedPluginExecutable;
        }>
        | Readonly<{ kind: 'runnerPackagedRuntime' }>;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function cloneManagedExecutableRef(
    executable: ManagedExecutableRef,
): ManagedExecutableRef {
    if (executable.kind === 'packaged-runtime-binary') {
        return Object.freeze({
            kind: executable.kind,
            directorySegments: Object.freeze([
                ...executable.directorySegments,
            ]),
            executableBaseName: executable.executableBaseName,
        });
    }
    return Object.freeze({
        kind: executable.kind,
        id: typeof executable.id === 'string'
            ? executable.id
            : Object.freeze({ ...executable.id }),
    });
}

export function projectRunnerManagedProviderServerLaunchAuthority(
    spec: ManagedServiceSpec,
): RunnerManagedProviderServerLaunchAuthority | null {
    if (spec.mode.kind !== 'spawn') return null;
    return Object.freeze({
        serverId: spec.id,
        executable: cloneManagedExecutableRef(
            spec.mode.launch.executable,
        ),
        environmentKeys: projectManagedServiceSpawnEnvironmentKeys(spec),
    });
}

export async function authorizeRunnerManagedProviderServerSupervision(
    input: Readonly<{
        paths: PluginStorePaths;
        sessionId: string;
        request: RunnerManagedServiceSupervisionAuthorizationRequest;
        processEnv?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        bootstrap: RunnerDaemonManagedProviderBootstrapV1;
        expectedLaunch: RunnerManagedProviderServerLaunchAuthority;
}>,
): Promise<RunnerManagedServiceSupervisionAuthorization> {
    const bootstrap = input.bootstrap;
    const scope = bootstrap.scope;
    const contributionId =
        `${scope.pluginId}/providers/${scope.providerLocalId}`;
    if (input.request.contributionId !== contributionId) {
        return fail(
            'plugin_managed_server_contribution_denied',
            'Managed Provider server contribution identity is not authorized',
        );
    }
    if (
        input.request.operationClaimId === undefined
        || input.request.operationClaimId
            !== scope.operationClaimId
    ) {
        return fail(
            'plugin_managed_server_operation_claim_denied',
            'Managed Provider server operation claim is not authorized',
        );
    }
    if (
        input.request.immutableGenerationId
            !== scope.immutableGenerationId
        || scope.sessionId !== input.sessionId
    ) {
        return fail(
            'plugin_managed_server_declaration_stale',
            'Managed Provider retained authority is unavailable',
        );
    }
    const executable = input.request.executable;
    if (executable.kind !== 'packaged-runtime-binary') {
        return fail(
            'plugin_managed_server_executable_unavailable',
            'Managed Provider packaged runtime is unavailable',
        );
    }
    if (
        input.request.serverId !== input.expectedLaunch.serverId
        || !isDeepStrictEqual(
            input.request.executable,
            input.expectedLaunch.executable,
        )
        || !isDeepStrictEqual(
            input.request.environmentKeys,
            input.expectedLaunch.environmentKeys,
        )
    ) {
        return fail(
            'plugin_managed_server_launch_denied',
            'Managed Provider server launch does not match its exact operation input',
        );
    }
    const basis = scope.runtimeBindingBasis;
    if (
        basis.deployment.kind !== 'managedLocal'
        || basis.deployment.implementationIdentity.pluginId
            !== scope.pluginId
        || basis.deployment.implementationIdentity.localId
            !== scope.providerLocalId
    ) {
        return fail(
            'plugin_managed_server_declaration_stale',
            'Managed Provider bootstrap identity is unavailable',
        );
    }
    const generation =
        await readPreparedImmutablePluginGeneration({
            paths: input.paths,
            immutableGenerationId:
                scope.immutableGenerationId,
        });
    if (
        generation.record.pluginId !== scope.pluginId
    ) {
        return fail(
            'plugin_managed_server_generation_stale',
            'Managed Provider server generation is unavailable',
        );
    }
    const manifest = await readPluginManifest({
        manifestPath: join(
            generation.rootPath,
            ...generation.record.manifestRelativePath.split('/'),
        ),
        manifestAuthority: scope.manifestAuthority,
        sourceProvenance: generation.record.sourceProvenance,
    });
    const provider = manifest.ok
        ? manifest.manifest.contributes.providers.find(
            (candidate) => candidate.id
                === scope.providerLocalId,
        )
        : undefined;
    if (
        !manifest.ok
        || manifest.manifest.id !== scope.pluginId
        || provider?.managedRuntime?.kind !== 'managed'
    ) {
        return fail(
            'plugin_managed_server_declaration_stale',
            'Managed Provider server declaration is unavailable',
        );
    }
    const identity = Object.freeze({
        pluginId: scope.pluginId,
        localId: scope.providerLocalId,
    });
    const declaration = resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: identity,
        managedRuntime: provider.managedRuntime,
    });
    const endpoint = provider.endpointTemplates.find(
        (candidate) => candidate.id
            === basis.endpoint.endpointTemplateId,
    );
    if (
        !declaration.endpointTemplateIds.includes(
            basis.endpoint.endpointTemplateId,
        )
        || endpoint?.protocol !== basis.endpoint.protocol
        || !isDeepStrictEqual(
            declaration,
            basis.deployment.managedRuntime,
        )
    ) {
        return fail(
            'plugin_managed_server_declaration_stale',
            'Managed Provider server launch does not match immutable P',
        );
    }
    if (scope.manifestAuthority === 'external') {
        const command =
            await resolveCurrentInstalledPluginGenerationRuntimeExecutable({
                executable,
                rootPath: generation.rootPath,
                files: generation.record.files,
                isCurrent: async () =>
                    await readCurrentPluginImmutableGenerationIntegrityCurrentness({
                        paths: input.paths,
                        pluginId: scope.pluginId,
                        immutableGenerationId: scope.immutableGenerationId,
                        retainedManifestAuthority: scope.manifestAuthority,
                    }),
            });
        if (!command) {
            return fail(
                'plugin_managed_server_executable_unavailable',
                'Managed Provider packaged runtime is unavailable',
            );
        }
        return Object.freeze({
            launch: Object.freeze({
                kind: 'daemonResolved' as const,
                value: Object.freeze({ command }),
            }),
        });
    }

    // Bundled first-party Provider payloads remain bound to the exact retained
    // CLI runner snapshot, which owns their packaged runtime artifact.
    return Object.freeze({
        launch: Object.freeze({ kind: 'runnerPackagedRuntime' as const }),
    });
}

function refEquals(
    left: ManagedExecutableRef,
    right: ManagedExecutableRef,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function refIdentity(
    ref: Extract<ManagedExecutableRef, Readonly<{ kind: 'systemTool' }>>,
    requestingPluginId: string,
): Readonly<{ pluginId: string; localId: string }> {
    return typeof ref.id === 'string'
        ? { pluginId: requestingPluginId, localId: ref.id }
        : ref.id;
}

export async function authorizeRunnerManagedServiceSupervision(
    input: RunnerManagedAgentServiceSupervisionAuthorizationInput,
): Promise<RunnerManagedServiceSupervisionAuthorization> {
    const binding = input.binding;
    const contributionId = resolveAgentContributionQualifiedId({
        pluginId: binding.pluginId,
        localId: binding.localAgentId,
    });
    if (
        input.request.contributionId !== contributionId
        || input.request.immutableGenerationId
            !== binding.immutableGenerationId
    ) {
        return fail(
            'plugin_managed_server_contribution_denied',
            'Managed server contribution identity is not authorized',
        );
    }
    const attested = await verifyRunnerAgentBindingAgainstGeneration({
        paths: input.paths,
        binding,
    });
    const { manifest } = attested;
    const processRequests = [
        ...manifest.hostAccess.required,
        ...manifest.hostAccess.optional,
    ].filter(
        (request): request is Extract<typeof request, {
            capability: 'process';
        }> => request.capability === 'process',
    );
    const executableDeclared = processRequests.some((request) =>
        request.scope.executables.some((candidate) =>
            refEquals(candidate, input.request.executable)
        )
    );
    const declaredEnvironmentKeys = new Set(
        processRequests.flatMap(
            (request) => request.scope.envKeys ?? [],
        ),
    );
    if (
        !executableDeclared
        || input.request.environmentKeys.some(
            (key) => !declaredEnvironmentKeys.has(key),
        )
    ) {
        return fail(
            'plugin_managed_server_launch_denied',
            'Managed server launch is outside declared HostAccess',
        );
    }
    if (input.request.executable.kind !== 'systemTool') {
        return fail(
            'plugin_managed_server_executable_unavailable',
            'Runner managed-dependency launch is unavailable',
        );
    }
    const identity = refIdentity(
        input.request.executable,
        binding.pluginId,
    );
    const declaration =
        manifest.contributes.systemTools.find(
            (candidate) =>
                identity.pluginId === binding.pluginId
                && candidate.id === identity.localId,
        );
    if (!declaration) {
        return fail(
            'plugin_system_tool_undeclared',
            'Managed server system tool is not declared',
        );
    }
    const resolver = createDaemonSpawnToolResolutionContext({
        processEnv: input.processEnv ?? process.env,
        ...(input.signal ? { signal: input.signal } : {}),
    });
    const resolved = await resolver.resolveSystemTool({
        toolId: `${identity.pluginId}/${identity.localId}`,
        lookupNames: declaration.executableNames,
        reason: 'Authorize runner-owned managed server launch',
    });
    if (!resolved.ok || !isAbsolute(resolved.command)) {
        return fail(
            'plugin_system_tool_unavailable',
            'Managed server system tool is unavailable',
        );
    }
    return Object.freeze({
        launch: Object.freeze({
            kind: 'daemonResolved' as const,
            value: Object.freeze({
                command: resolved.command,
                args: Object.freeze([...(resolved.args ?? [])]),
                env: Object.freeze({ PATH: '' }),
                ...(declaration.allowedArguments
                    ? {
                        allowedArguments: Object.freeze([
                            ...declaration.allowedArguments,
                        ]),
                    }
                    : {}),
            }),
        }),
    });
}
