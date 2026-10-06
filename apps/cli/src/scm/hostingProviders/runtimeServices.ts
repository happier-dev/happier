import { ConnectedAccountHttpHeadersRequestSchema } from '@happier-dev/protocol/connect/connected-account-purposes';
import { ScmHostingProviderRefSchema } from '@happier-dev/protocol/scm/pullRequests';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { ManagedExecutableRef } from '@happier-dev/protocol';
import type {
    HostingProviderRuntimeCommandResult as ScmHostingProviderRuntimeCommandResult,
    HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import { z } from 'zod';
import {
    createScmHostingProviderRegistry,
    type ResolvedScmHostingProviderRegistry,
    type ScmHostingProviderConfiguredDeployments,
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
import {
    CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT,
    type StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedScmHostingProviderContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { clonePluginPlainData } from '@/plugins/runtime/plainData';
import { readHostingProviderExecutionAuthority } from './executionAuthority';
import { normalizeConnectedAccountConfiguredBase } from '@/plugins/runtime/connectedAccounts/configuredOrigins';

type ScmHostingProviderRuntimeRegistryInput = Readonly<{
    contributes: Readonly<{
        scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
        connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
        systemTools?: ResolvedExecutablePluginRuntimeRegistry['contributes']['systemTools'];
    }>;
    scmHostingProvidersById: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
    envAllowedNamesByPluginId?: ResolvedExecutablePluginRuntimeRegistry['envAllowedNamesByPluginId'];
    managedDependencies?: Pick<StablePluginManagedDependenciesHost, 'resolveExecutable'>;
    resolveConnectedAccountPurposeBindingOwner?: () => (
        Pick<StablePluginConnectedAccountsOwner, 'materialize'>
        // Optional: a host that cannot list accounts recognizes no configured deployment, which
        // is exactly what an absent projection should mean.
        & Partial<Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'listAccounts'>>
    ) | null;
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

type ScmHostingProviderRuntimeMaterializationRequest =
    | ScmHostingProviderRuntimeTokenMaterializationRequest
    | ScmHostingProviderRuntimeBasicAuthMaterializationRequest;

const ScmHostingProviderRuntimeMaterializationRequestBaseSchema = z.object({
    providerId: z.string().min(1),
    host: z.string().min(1),
    provider: ScmHostingProviderRefSchema,
    profileId: z.string().nullable().optional(),
}).strict();

const ScmHostingProviderRuntimeMaterializationRequestSchema = z.discriminatedUnion('kind', [
    ScmHostingProviderRuntimeMaterializationRequestBaseSchema.extend({
        kind: z.literal('scm_hosting_token'),
    }),
    ScmHostingProviderRuntimeMaterializationRequestBaseSchema.extend({
        kind: z.literal('scm_hosting_basic_auth'),
    }),
]);

function invalidHostingMaterializationPlainData(label: string): Error {
    return new Error(`${label} must contain strict plain data`);
}

function snapshotHostingPlainData<T>(value: T, label: string): T {
    try {
        return clonePluginPlainData(value, {
            path: label,
            invalid: () => invalidHostingMaterializationPlainData(label),
        });
    } catch {
        throw invalidHostingMaterializationPlainData(label);
    }
}

function normalizeHostingMaterializationRequest(
    request: ScmHostingProviderRuntimeMaterializationRequest,
    expectedKind: ScmHostingProviderRuntimeMaterializationRequest['kind'],
): ScmHostingProviderRuntimeMaterializationRequest {
    const snapshot = snapshotHostingPlainData(
        request,
        'SCM hosting materialization request',
    );
    const parsed = ScmHostingProviderRuntimeMaterializationRequestSchema.safeParse(snapshot);
    if (!parsed.success || parsed.data.kind !== expectedKind) {
        throw invalidHostingMaterializationPlainData('SCM hosting materialization request');
    }
    return snapshot;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.values(value).every((entry) => typeof entry === 'string');
}

function snapshotHttpHeadersMaterialization(
    value: unknown,
): Readonly<{ kind: 'httpHeaders'; headers: Readonly<Record<string, string>> }> | null {
    const label = 'SCM hosting materialization result';
    const snapshot = snapshotHostingPlainData(value, label);
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw invalidHostingMaterializationPlainData(label);
    }
    const record = snapshot as Readonly<Record<string, unknown>>;
    if (record.kind !== 'httpHeaders') return null;
    const headers = record.headers;
    if (!isStringRecord(headers)) {
        throw invalidHostingMaterializationPlainData(label);
    }
    return Object.freeze({
        kind: 'httpHeaders',
        headers,
    });
}

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

function createScmConnectedAccountMaterializationRequest(origin: string) {
    return ConnectedAccountHttpHeadersRequestSchema.parse({
        kind: 'httpHeaders',
        origin,
        headerNames: ['authorization'],
    });
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

/**
 * The configured service bases of every Connected Account bound to each hosting provider's
 * `authService`, keyed by qualified provider id, together with what the owner could publish.
 *
 * This is the one projection that lets a self-managed deployment be recognized at all: a forge
 * without a product-owned hostname cannot be told from any other host by a remote URL alone.
 * The Connected Account owner remains the authority — this reads what it already published and
 * neither stores, re-spells, nor selects among deployments.
 *
 * The listing is asked for the whole authorized inventory the canonical metadata seam admits, so
 * no SCM-local ceiling can elide a deployment the owner would have published. That seam has no
 * cursor, so an elision it does report, and a listing that refuses outright, are both carried to
 * the registry rather than flattened into "nothing is configured".
 */
async function resolveScmHostingConfiguredDeployments(
    input: ScmHostingProviderRuntimeRegistryInput,
): Promise<ReadonlyMap<string, ScmHostingProviderConfiguredDeployments>> {
    const deploymentsByProviderId = new Map<string, ScmHostingProviderConfiguredDeployments>();
    const owner = input.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
    if (!owner?.listAccounts) return deploymentsByProviderId;
    for (const provider of input.contributes.scmHostingProviders ?? []) {
        if (!provider.pluginId) continue;
        const providerId = `${provider.pluginId}/${provider.definition.id}`;
        const authorization = resolveProviderPurposeAuthorization(input, providerId);
        if (!authorization) continue;
        try {
            const listed = await owner.listAccounts({
                ...authorization,
                limit: CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT,
                // The registry-resolution seam carries no caller signal, so there is nothing to
                // thread here; the owner still bounds the read itself.
                signal: new AbortController().signal,
            });
            deploymentsByProviderId.set(providerId, Object.freeze({
                bases: Object.freeze([...new Set(listed.accounts.flatMap(
                    (account) => [...account.connectedAccountBases],
                ))]),
                status: listed.status,
            }));
        } catch {
            // One provider's unavailable account listing must not fail the whole registry or let
            // another provider inherit its bases — and it must not be read as an empty inventory.
            deploymentsByProviderId.set(providerId, Object.freeze({
                bases: Object.freeze([]),
                status: 'unavailable',
            }));
        }
    }
    return deploymentsByProviderId;
}

export function createHostScmHostingProviderRegistry(
    input: ScmHostingProviderRuntimeRegistryInput,
    configuredDeploymentsByProviderId?: ReadonlyMap<string, ScmHostingProviderConfiguredDeployments>,
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
        occurrenceId: entry.occurrenceId,
        registration: entry.registration,
    }));

    return createScmHostingProviderRegistry({
        providers,
        runtimeRegistrations,
        ...(configuredDeploymentsByProviderId
            ? { configuredDeploymentsByProviderId }
            : {}),
    });
}

export function createHostScmHostingProviderRuntimeServices(
    input: ScmHostingProviderRuntimeRegistryInput,
): ScmHostingProviderRuntimeServices {
    const resolveScmHostingProviderRegistry = async (): Promise<ResolvedScmHostingProviderRegistry> => {
        return createHostScmHostingProviderRegistry(
            input,
            await resolveScmHostingConfiguredDeployments(input),
        );
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
        if (!current || current.occurrenceId !== authority.occurrenceId) {
            throw new Error('SCM hosting authentication generation is stale');
        }
    };
    async function resolveBoundHostingAccount(
        owner: NonNullable<ReturnType<NonNullable<ScmHostingProviderRuntimeRegistryInput['resolveConnectedAccountPurposeBindingOwner']>>>,
        authorization: NonNullable<ReturnType<typeof resolveProviderPurposeAuthorization>>,
        request: ScmHostingProviderRuntimeMaterializationRequest,
        origin: string,
        authority: ReturnType<typeof captureHostingAuthAuthority>,
        signal: AbortSignal,
    ) {
        if (!owner.getBinding || !owner.listAccounts) return null;
        let deployment: ReturnType<typeof normalizeConnectedAccountConfiguredBase>;
        try {
            deployment = normalizeConnectedAccountConfiguredBase(request.provider.baseUrl);
        } catch { return null; }
        if (deployment.origin !== origin) return null;
        const binding = await owner.getBinding({ ...authorization, signal });
        assertHostingAuthCurrent(authority, signal);
        if (!binding) return null;
        const listed = await owner.listAccounts({ ...authorization, limit: CONNECTED_ACCOUNT_METADATA_LIST_MAX_LIMIT, signal });
        assertHostingAuthCurrent(authority, signal);
        const selected = listed.accounts.find((account) => sameQualifiedConnectedAccountRef(account.account, binding.account));
        if (!selected) return null;
        if (selected.connectedAccountBases.length > 0) {
            const matches = selected.connectedAccountBases.some((base) => {
                try { return normalizeConnectedAccountConfiguredBase(base).base === deployment.base; }
                catch { return false; }
            });
            if (!matches) return null;
        } else if (deployment.base !== deployment.origin) {
            return null;
        }
        // Fixed-origin services may publish no configured base. Only a bare
        // origin can use that retained seam: the canonical account runtime still
        // validates origin, and expectedAccount pins its exact selected identity.
        return binding.account;
    }
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
            const requestSnapshot = normalizeHostingMaterializationRequest(
                request,
                'scm_hosting_token',
            );
            const authority = captureHostingAuthAuthority(requestSnapshot.providerId);
            assertHostingAuthCurrent(authority, options?.signal);
            const authorization = resolveProviderPurposeAuthorization(
                input,
                requestSnapshot.providerId,
            );
            if (!authorization) return { kind: 'missing', reason: 'unsupported_provider' };
            const origin = resolveHttpsOrigin(requestSnapshot.host);
            if (!origin) return { kind: 'missing', reason: 'unsupported_host' };
            if (requestSnapshot.profileId?.trim()) {
                return { kind: 'missing', reason: 'credential_unavailable' };
            }
            const owner =
                input.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
            if (!owner) return { kind: 'missing', reason: 'credential_unavailable' };
            const signal = options?.signal ?? new AbortController().signal;
            const expectedAccount = await resolveBoundHostingAccount(owner, authorization, requestSnapshot, origin, authority, signal);
            if (!expectedAccount) return { kind: 'missing', reason: 'credential_unavailable' };
            const result = await owner.materialize({
                ...authorization,
                expectedAccount,
                request: createScmConnectedAccountMaterializationRequest(origin),
                signal,
            });
            assertHostingAuthCurrent(authority, options?.signal);
            let resultSnapshot: ReturnType<typeof snapshotHttpHeadersMaterialization>;
            try {
                resultSnapshot = snapshotHttpHeadersMaterialization(result);
            } finally {
                assertHostingAuthCurrent(authority, options?.signal);
            }
            if (!resultSnapshot) {
                return { kind: 'missing', reason: 'unsupported_materialization' };
            }
            const token = readBearerToken(resultSnapshot.headers);
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
            const requestSnapshot = normalizeHostingMaterializationRequest(
                request,
                'scm_hosting_basic_auth',
            );
            const authority = captureHostingAuthAuthority(requestSnapshot.providerId);
            assertHostingAuthCurrent(authority, options?.signal);
            const authorization = resolveProviderPurposeAuthorization(
                input,
                requestSnapshot.providerId,
            );
            if (!authorization) return { kind: 'missing', reason: 'unsupported_provider' };
            const origin = resolveHttpsOrigin(requestSnapshot.host);
            if (!origin) return { kind: 'missing', reason: 'unsupported_host' };
            if (requestSnapshot.profileId?.trim()) {
                return { kind: 'missing', reason: 'credential_unavailable' };
            }
            const owner =
                input.resolveConnectedAccountPurposeBindingOwner?.() ?? null;
            if (!owner) return { kind: 'missing', reason: 'credential_unavailable' };
            const signal = options?.signal ?? new AbortController().signal;
            const expectedAccount = await resolveBoundHostingAccount(owner, authorization, requestSnapshot, origin, authority, signal);
            if (!expectedAccount) return { kind: 'missing', reason: 'credential_unavailable' };
            const result = await owner.materialize({
                ...authorization,
                expectedAccount,
                request: createScmConnectedAccountMaterializationRequest(origin),
                signal,
            });
            assertHostingAuthCurrent(authority, options?.signal);
            let resultSnapshot: ReturnType<typeof snapshotHttpHeadersMaterialization>;
            try {
                resultSnapshot = snapshotHttpHeadersMaterialization(result);
            } finally {
                assertHostingAuthCurrent(authority, options?.signal);
            }
            if (!resultSnapshot) {
                return { kind: 'missing', reason: 'unsupported_materialization' };
            }
            const credentials = readBasicCredentials(resultSnapshot.headers);
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
                if (!current || current.occurrenceId !== authority.occurrenceId) {
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
                    isOccurrenceCurrent: () => {
                        const latest = input.scmHostingProvidersById.get(qualifiedId);
                        return latest?.occurrenceId === authority.occurrenceId;
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
