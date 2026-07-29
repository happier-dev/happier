import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeCommandResult,
    ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/experimental/scm';
import {
    createScmHostingProviderRegistry,
    type ResolvedScmHostingProviderRegistry,
    type ScmHostingProviderDescriptor,
    type ScmHostingProviderRuntimeBinding,
} from './registry';
import { createDaemonSpawnToolResolutionContext } from '@/daemon/spawnHooks';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { createStableManagedExecutableResolver } from '@/plugins/runtime/invocation/services/managedExecutableResolver';
import type { StablePluginManagedDependenciesHost } from '@/plugins/runtime/invocation/services/managedDependencies';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    deriveScmHostingProviderConnectedAccountPurposeAuthorization,
} from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import type {
    StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedScmHostingProviderContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { readHostingProviderExecutionAuthority } from './executionAuthority';

type ScmHostingProviderRuntimeRegistryInput = Readonly<{
    contributes: Readonly<{
        scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
        connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
        systemTools?: ResolvedExecutablePluginRuntimeRegistry['contributes']['systemTools'];
    }>;
    scmHostingProvidersById: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
    envAllowedNamesByPluginId?: ResolvedExecutablePluginRuntimeRegistry['envAllowedNamesByPluginId'];
    managedDependencies?: Pick<StablePluginManagedDependenciesHost, 'resolveExecutable'>;
    resolveConnectedAccountPurposeBindingOwner?: () =>
        Pick<StablePluginConnectedAccountsOwner, 'materialize'> | null;
    executeCommand?: (
        input: Readonly<{
            executable: ManagedExecutableRef;
            args: readonly string[];
            timeoutMs: number;
            env?: Readonly<Record<string, string>>;
            maxStdoutBytes?: number;
            maxStderrBytes?: number;
        }>,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<ScmHostingProviderRuntimeCommandResult>;
}>;

type ScmHostingProviderRuntimeTokenMaterializationRequest = Parameters<
    NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingTokenMaterialization']>
>[0];

type ScmHostingProviderRuntimeBasicAuthMaterializationRequest = Parameters<
    NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingBasicAuthMaterialization']>
>[0];

function assertHostingOperationCurrent(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('SCM hosting operation was aborted');
}

function normalizeUrlSafety(
    provider: Readonly<{
        urlSafety?: Readonly<{
            allowedSchemes?: readonly string[];
            allowedBaseUrls?: readonly string[];
            allowedOrigins?: readonly string[];
        }>;
    }>,
): NonNullable<ScmHostingProviderDescriptor['urlSafety']> {
    return {
        allowedSchemes: provider.urlSafety?.allowedSchemes ?? ['https:'],
        allowedBaseUrls: provider.urlSafety?.allowedBaseUrls ?? [],
        allowedOrigins: provider.urlSafety?.allowedOrigins ?? [],
    };
}

function resolveProviderPurposeAuthorization(
    input: ScmHostingProviderRuntimeRegistryInput,
    providerId: string,
): ReturnType<typeof deriveScmHostingProviderConnectedAccountPurposeAuthorization> {
    const provider = (input.contributes.scmHostingProviders ?? []).find((candidate) => (
        candidate.pluginId
        && `${candidate.pluginId}/${candidate.definition.id}` === providerId
    ));
    if (!provider) return null;
    const authorization =
        deriveScmHostingProviderConnectedAccountPurposeAuthorization(provider);
    if (!authorization) return null;
    const [service] = authorization.serviceRefs;
    if (!service) return null;
    const descriptorExists = (input.contributes.connectedAccountDescriptors ?? []).some(
        (candidate) => (
            candidate.pluginId === service.pluginId
            && candidate.definition.id === service.localId
        ),
    );
    return descriptorExists ? authorization : null;
}

function resolveHttpsOrigin(host: string): string | null {
    const normalized = host.trim();
    if (!normalized) return null;
    try {
        const parsed = new URL(
            normalized.includes('://') ? normalized : `https://${normalized}`,
        );
        if (
            parsed.protocol !== 'https:'
            || parsed.username
            || parsed.password
            || parsed.pathname !== '/'
            || parsed.search
            || parsed.hash
        ) {
            return null;
        }
        return parsed.origin;
    } catch {
        return null;
    }
}

function readHttpHeader(
    headers: Readonly<Record<string, string>>,
    name: string,
): string | null {
    const entry = Object.entries(headers).find(
        ([candidate]) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return entry?.[1]?.trim() || null;
}

function readBearerToken(headers: Readonly<Record<string, string>>): string | null {
    const authorization = readHttpHeader(headers, 'authorization');
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim() || null;
}

function readBasicCredentials(
    headers: Readonly<Record<string, string>>,
): Readonly<{ username: string; password: string }> | null {
    const authorization = readHttpHeader(headers, 'authorization');
    const match = authorization?.match(/^Basic\s+([A-Za-z0-9+/]+={0,2})$/i);
    if (!match?.[1]) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator <= 0) return null;
    const username = decoded.slice(0, separator).trim();
    const password = decoded.slice(separator + 1);
    return username && password ? { username, password } : null;
}

export function createHostScmHostingProviderRegistry(
    input: ScmHostingProviderRuntimeRegistryInput,
): ResolvedScmHostingProviderRegistry {
    const providers: ScmHostingProviderDescriptor[] = (input.contributes.scmHostingProviders ?? [])
        .flatMap((provider) => {
            const { title, ...definition } = provider.definition;
            return [Object.freeze({
                ...definition,
                displayName: typeof title === 'string' ? title : title.fallback,
                pluginId: provider.pluginId,
                urlSafety: normalizeUrlSafety({}),
            })];
        });
    const runtimeRegistrations: ScmHostingProviderRuntimeBinding[] = [
        ...input.scmHostingProvidersById.values(),
    ].map((entry) => ({
        pluginId: entry.pluginId,
        generation: entry.generation,
        registration: entry.registration,
    }));

    return createScmHostingProviderRegistry({
        providers,
        runtimeRegistrations,
    });
}

export function createHostScmHostingProviderRuntimeServices(
    input: ScmHostingProviderRuntimeRegistryInput,
): ScmHostingProviderRuntimeServices {
    const resolveScmHostingProviderRegistry = async (): Promise<ResolvedScmHostingProviderRegistry> => {
        return createHostScmHostingProviderRegistry(input);
    };
    const captureHostingAuthAuthority = (providerId: string) => {
        const authority = readHostingProviderExecutionAuthority();
        if (!authority) {
            throw new Error('SCM hosting authentication requires a provider-qualified invocation');
        }
        const qualifiedId = `${authority.pluginId}/${authority.contributionId}`;
        if (providerId !== qualifiedId) {
            throw new Error('SCM hosting authentication provider authority does not match the request');
        }
        return Object.freeze({ ...authority, qualifiedId });
    };
    const assertHostingAuthCurrent = (
        authority: ReturnType<typeof captureHostingAuthAuthority>,
        signal?: AbortSignal,
    ): void => {
        assertHostingOperationCurrent(signal);
        const current = input.scmHostingProvidersById.get(authority.qualifiedId);
        if (!current || current.generation !== authority.generation) {
            throw new Error('SCM hosting authentication generation is stale');
        }
    };
    const systemToolContext = createDaemonSpawnToolResolutionContext({ processEnv: process.env });
    const executableResolver = createStableManagedExecutableResolver({
        systemTools: input.contributes.systemTools ?? [],
        managedDependencies: input.managedDependencies ?? {
            async resolveExecutable() {
                throw new PluginError({
                    code: 'plugin_managed_dependency_unavailable',
                    message: 'Managed dependency execution is unavailable in the SCM hosting host',
                });
            },
        },
        async resolveSystemTool(request) {
            const resolved = await systemToolContext.resolveSystemTool({
                toolId: request.toolId,
                lookupNames: request.executableNames,
                reason: 'Execute the declared SCM hosting-provider command',
            });
            if (!resolved.ok) {
                throw new PluginError({ code: 'plugin_system_tool_unavailable', message: 'System tool is unavailable' });
            }
            return {
                toolId: request.toolId,
                command: resolved.command,
                args: resolved.args,
            };
        },
    });

    const services: ScmHostingProviderRuntimeServices = {
        async resolveScmHostingTokenMaterialization(
            request: ScmHostingProviderRuntimeTokenMaterializationRequest,
            options,
        ) {
            const authority = captureHostingAuthAuthority(request.providerId);
            assertHostingAuthCurrent(authority, options?.signal);
            const authorization = resolveProviderPurposeAuthorization(
                input,
                request.providerId,
            );
            if (!authorization) return { kind: 'missing', reason: 'unsupported_provider' };
            const origin = resolveHttpsOrigin(request.host);
            if (!origin) return { kind: 'missing', reason: 'unsupported_host' };
            if (request.profileId?.trim()) {
                return { kind: 'missing', reason: 'credential_unavailable' };
            }
            const owner =
                input.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
            if (!owner) return { kind: 'missing', reason: 'credential_unavailable' };
            const signal = options?.signal ?? new AbortController().signal;
            const result = await owner.materialize({
                ...authorization,
                request: {
                    kind: 'httpHeaders',
                    origin,
                    headerNames: ['Authorization'],
                },
                signal,
            });
            assertHostingAuthCurrent(authority, options?.signal);
            if (result.kind !== 'httpHeaders') {
                return { kind: 'missing', reason: 'unsupported_materialization' };
            }
            const token = readBearerToken(result.headers);
            if (!token) return { kind: 'missing', reason: 'credential_unavailable' };
            return {
                kind: 'available',
                token,
            };
        },
        async resolveScmHostingBasicAuthMaterialization(
            request: ScmHostingProviderRuntimeBasicAuthMaterializationRequest,
            options,
        ) {
            const authority = captureHostingAuthAuthority(request.providerId);
            assertHostingAuthCurrent(authority, options?.signal);
            const authorization = resolveProviderPurposeAuthorization(
                input,
                request.providerId,
            );
            if (!authorization) return { kind: 'missing', reason: 'unsupported_provider' };
            const origin = resolveHttpsOrigin(request.host);
            if (!origin) return { kind: 'missing', reason: 'unsupported_host' };
            if (request.profileId?.trim()) {
                return { kind: 'missing', reason: 'credential_unavailable' };
            }
            const owner =
                input.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
            if (!owner) return { kind: 'missing', reason: 'credential_unavailable' };
            const signal = options?.signal ?? new AbortController().signal;
            const result = await owner.materialize({
                ...authorization,
                request: {
                    kind: 'httpHeaders',
                    origin,
                    headerNames: ['Authorization'],
                },
                signal,
            });
            assertHostingAuthCurrent(authority, options?.signal);
            if (result.kind !== 'httpHeaders') {
                return { kind: 'missing', reason: 'unsupported_materialization' };
            }
            const credentials = readBasicCredentials(result.headers);
            if (!credentials) {
                return { kind: 'missing', reason: 'credential_unavailable' };
            }
            return {
                kind: 'available',
                username: credentials.username,
                password: credentials.password,
            };
        },
        async executeCommand(request, options) {
                const authority = readHostingProviderExecutionAuthority();
                if (!authority) {
                    throw new Error('SCM hosting command execution requires a provider-qualified invocation');
                }
                const qualifiedId = `${authority.pluginId}/${authority.contributionId}`;
                const current = input.scmHostingProvidersById.get(qualifiedId);
                if (!current || current.generation !== authority.generation) {
                    throw new Error('SCM hosting command execution generation is stale');
                }
                if (options?.signal?.aborted) {
                    throw new Error('SCM hosting command execution was aborted');
                }
                if (input.executeCommand) return await input.executeCommand(request, options);
                const signal = options?.signal ?? new AbortController().signal;
                const service = createStablePluginExecService({
                    allowedExecutables: [request.executable],
                    allowedEnvKeys: [...(input.envAllowedNamesByPluginId?.get(authority.pluginId) ?? [])],
                    signal,
                    isGenerationCurrent: () => {
                        const latest = input.scmHostingProvidersById.get(qualifiedId);
                        return latest?.generation === authority.generation;
                    },
                    resolveExecutable: async (executable) => await executableResolver(executable, authority.pluginId),
                    async resolvePath() {
                        throw new PluginError({ code: 'plugin_exec_cwd_denied', message: 'SCM hosting commands do not accept plugin paths' });
                    },
                });
                const result = await service.run({
                    executable: request.executable,
                    args: request.args,
                    timeoutMs: request.timeoutMs,
                    ...(request.env ? { env: request.env } : {}),
                    maxStdoutBytes: request.maxStdoutBytes ?? 4 * 1024 * 1024,
                    maxStderrBytes: request.maxStderrBytes ?? 4 * 1024 * 1024,
                }, options);
                const observed = result.termination.observed;
                return Object.freeze({
                    ok: observed.kind === 'exit' && observed.exitCode === 0,
                    stdout: Buffer.from(result.stdout).toString('utf8'),
                    stderr: Buffer.from(result.stderr).toString('utf8'),
                    exitCode: observed.kind === 'exit' ? observed.exitCode : null,
                });
        },
        resolveScmHostingProviderRegistry,
    };
    return Object.freeze(services);
}
