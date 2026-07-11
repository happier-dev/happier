import {
    AsyncTtlCache,
    ConnectedServiceCredentialRecordV1Schema,
    openConnectedServiceCredentialCiphertext,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeCommandResolution,
    ScmHostingProviderRuntimeCommandResult,
    ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';
import {
    createScmHostingProviderRegistry,
    type ResolvedScmHostingProviderRegistry,
    type ScmHostingProviderDescriptor,
    type ScmHostingProviderRuntimeBinding,
} from './registry';

import {
    createConnectedServiceCredentialApi,
    type ConnectedServiceCredentialApi,
} from '@/api/client/connectedServiceCredentialApi';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { getAzDepStatus } from '@/capabilities/deps/az';
import { getGhDepStatus } from '@/capabilities/deps/gh';
import { readCredentials } from '@/persistence';
import type {
    ResolvedConnectedAccountDescriptorContribution,
    ResolvedScmHostingProviderContribution,
} from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    resolveScmHostingBasicAuthMaterialization,
    resolveScmHostingBasicAuthServiceId,
    resolveScmHostingTokenMaterialization,
    resolveScmHostingTokenServiceId,
    type ScmHostingAuthMaterializationRegistry,
} from './auth';

type ScmHostingProviderRuntimeRegistryInput = Readonly<{
    contributes: Readonly<{
        scmHostingProviders?: readonly ResolvedScmHostingProviderContribution[];
        connectedAccountDescriptors?: readonly ResolvedConnectedAccountDescriptorContribution[];
    }>;
    scmHostingProvidersById: ResolvedExecutablePluginRuntimeRegistry['scmHostingProvidersById'];
}>;

type ScmHostingProviderRuntimeTokenMaterializationRequest = Parameters<
    NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingTokenMaterialization']>
>[0];

type ScmHostingProviderRuntimeBasicAuthMaterializationRequest = Parameters<
    NonNullable<ScmHostingProviderRuntimeServices['resolveScmHostingBasicAuthMaterialization']>
>[0];

type ConnectedServicesCredentialApi = Pick<
    ConnectedServiceCredentialApi,
    'getConnectedServiceCredentialPlain' | 'getConnectedServiceCredentialSealed' | 'listConnectedServiceProfiles'
>;

const DEFAULT_CONNECTED_SERVICE_PROFILE_ID = 'default';
const DEFAULT_SCM_HOSTING_CREDENTIAL_RECORDS_SUCCESS_TTL_MS = 10_000;
const DEFAULT_SCM_HOSTING_CREDENTIAL_RECORDS_ERROR_TTL_MS = 1_000;

type ScmHostingCredentialRecordsCache = AsyncTtlCache<readonly ConnectedServiceCredentialRecordV1[]>;

function buildCredentialRecordsCacheKey(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId?: string | null;
}>): string {
    return JSON.stringify({
        serviceId: input.serviceId,
        profileId: input.profileId?.trim() || null,
    });
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

async function readCredentialRecord(input: Readonly<{
    api: ConnectedServicesCredentialApi;
    credentials: NonNullable<Awaited<ReturnType<typeof readCredentials>>>;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
    const plain = await input.api.getConnectedServiceCredentialPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
    }).catch(() => null);
    if (plain?.content.v !== undefined) {
        const parsedPlain = ConnectedServiceCredentialRecordV1Schema.safeParse(plain.content.v);
        if (parsedPlain.success) return parsedPlain.data;
    }

    const sealed = await input.api.getConnectedServiceCredentialSealed({
        serviceId: input.serviceId,
        profileId: input.profileId,
    }).catch(() => null);
    if (!sealed) return null;

    const opened = openConnectedServiceCredentialCiphertext({
        material: input.credentials.encryption,
        ciphertext: sealed.sealed.ciphertext,
    });
    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened?.value);
    return parsed.success ? parsed.data : null;
}

async function listProfileIds(input: Readonly<{
    api: ConnectedServicesCredentialApi;
    serviceId: ConnectedServiceId;
    profileId?: string | null;
}>): Promise<readonly string[]> {
    const explicit = input.profileId?.trim();
    if (explicit) return [explicit];

    const listed = await input.api.listConnectedServiceProfiles({
        serviceId: input.serviceId,
    }).catch(() => null);
    const profileIds = listed?.profiles
        .map((profile) => profile.profileId.trim())
        .filter((profileId) => profileId.length > 0) ?? [];
    return profileIds.length > 0 ? profileIds : [DEFAULT_CONNECTED_SERVICE_PROFILE_ID];
}

async function readConnectedServiceCredentialRecords(input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId?: string | null;
    cache?: ScmHostingCredentialRecordsCache;
}>): Promise<readonly ConnectedServiceCredentialRecordV1[]> {
    const cacheKey = buildCredentialRecordsCacheKey(input);
    const cached = input.cache?.get(cacheKey) ?? null;
    if (cached && input.cache?.isFresh(cached)) {
        return cached.kind === 'success' ? cached.value : [];
    }

    const cache = input.cache;
    if (cache) {
        return await cache.runDedupe(cacheKey, async () => {
            const cachedAfterDedupe = cache.get(cacheKey) ?? null;
            if (cachedAfterDedupe && cache.isFresh(cachedAfterDedupe)) {
                return cachedAfterDedupe.kind === 'success' ? cachedAfterDedupe.value : [];
            }

            try {
                const records = await readConnectedServiceCredentialRecords({
                    serviceId: input.serviceId,
                    profileId: input.profileId,
                });
                cache.setSuccess(cacheKey, records);
                return records;
            } catch {
                cache.setError(cacheKey);
                return [];
            }
        });
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) return [];
    const api = createConnectedServiceCredentialApi(credentials);
    const records: ConnectedServiceCredentialRecordV1[] = [];
    for (const profileId of await listProfileIds({
        api,
        serviceId: input.serviceId,
        profileId: input.profileId,
    })) {
        const record = await readCredentialRecord({
            api,
            credentials,
            serviceId: input.serviceId,
            profileId,
        });
        if (record) records.push(record);
    }
    return records;
}

async function resolveHostingInstallableCommand(
    input: Readonly<{ capabilityId: string }>,
): Promise<ScmHostingProviderRuntimeCommandResolution> {
    if (input.capabilityId === 'dep.az') {
        const status = await getAzDepStatus({ onlyIfInstalled: true });
        if (!status?.installed || !status.binPath || !status.resolvedSource) {
            return { kind: 'missing' };
        }
        return {
            kind: 'available',
            source: status.resolvedSource,
            binPath: status.binPath,
        };
    }
    if (input.capabilityId !== 'dep.gh') return { kind: 'missing' };
    const status = await getGhDepStatus({ onlyIfInstalled: true });
    if (!status.installed || !status.binPath || !status.resolvedSource) {
        return { kind: 'missing' };
    }
    return {
        kind: 'available',
        source: status.resolvedSource,
        binPath: status.binPath,
    };
}

async function runHostingCommand(
    request: Readonly<{
        binPath: string;
        args: readonly string[];
        timeoutMs: number;
        env?: Readonly<Record<string, string>>;
    }>,
): Promise<ScmHostingProviderRuntimeCommandResult> {
    return await runCliCommandBestEffort({
        resolvedPath: request.binPath,
        args: [...request.args],
        timeoutMs: request.timeoutMs,
        env: request.env,
    });
}

export function createHostScmHostingProviderRegistry(
    input: ScmHostingProviderRuntimeRegistryInput,
): ResolvedScmHostingProviderRegistry {
    const providers: ScmHostingProviderDescriptor[] = (input.contributes.scmHostingProviders ?? [])
        .map((provider) => {
            const { urlSafety: sourceUrlSafety, ...definition } = provider.definition;
            void sourceUrlSafety;
            return Object.freeze({
                ...definition,
                pluginId: provider.pluginId,
                urlSafety: normalizeUrlSafety(provider.definition),
            });
        });
    const runtimeRegistrations: ScmHostingProviderRuntimeBinding[] = [
        ...input.scmHostingProvidersById.values(),
    ].map((entry) => ({
        pluginId: entry.pluginId,
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
    let providerRegistry: ResolvedScmHostingProviderRegistry | null = null;
    const resolveScmHostingProviderRegistry = async (): Promise<ResolvedScmHostingProviderRegistry> => {
        providerRegistry ??= createHostScmHostingProviderRegistry(input);
        return providerRegistry;
    };
    const authMaterializationRegistry: ScmHostingAuthMaterializationRegistry = {
        scmHostingProvidersById: input.scmHostingProvidersById,
    };
    const connectedServiceCredentialRecordsCache: ScmHostingCredentialRecordsCache = new AsyncTtlCache({
        successTtlMs: DEFAULT_SCM_HOSTING_CREDENTIAL_RECORDS_SUCCESS_TTL_MS,
        errorTtlMs: DEFAULT_SCM_HOSTING_CREDENTIAL_RECORDS_ERROR_TTL_MS,
    });

    const services: ScmHostingProviderRuntimeServices = {
        async resolveScmHostingTokenMaterialization(
            request: ScmHostingProviderRuntimeTokenMaterializationRequest,
        ) {
            const serviceId = await resolveScmHostingTokenServiceId(request, authMaterializationRegistry);
            if (!serviceId) {
                return await resolveScmHostingTokenMaterialization({ ...request, records: [] }, authMaterializationRegistry);
            }
            const records = await readConnectedServiceCredentialRecords({
                serviceId,
                profileId: request.profileId,
                cache: connectedServiceCredentialRecordsCache,
            });
            const result = await resolveScmHostingTokenMaterialization({
                kind: request.kind,
                providerId: request.providerId,
                host: request.host,
                ...(request.profileId ? { profileId: request.profileId } : {}),
                records,
            }, authMaterializationRegistry);
            if (result.kind !== 'available') return result;
            return {
                kind: 'available',
                token: result.token,
                profileKey: `${result.serviceId}:${result.profileId}`,
            };
        },
        async resolveScmHostingBasicAuthMaterialization(
            request: ScmHostingProviderRuntimeBasicAuthMaterializationRequest,
        ) {
            const serviceId = await resolveScmHostingBasicAuthServiceId(request, authMaterializationRegistry);
            if (!serviceId) {
                return await resolveScmHostingBasicAuthMaterialization({ ...request, records: [] }, authMaterializationRegistry);
            }
            const records = await readConnectedServiceCredentialRecords({
                serviceId,
                profileId: request.profileId,
                cache: connectedServiceCredentialRecordsCache,
            });
            const result = await resolveScmHostingBasicAuthMaterialization({
                kind: request.kind,
                providerId: request.providerId,
                host: request.host,
                ...(request.profileId ? { profileId: request.profileId } : {}),
                records,
            }, authMaterializationRegistry);
            if (result.kind !== 'available') return result;
            return {
                kind: 'available',
                username: result.username,
                password: result.password,
                profileKey: `${result.serviceId}:${result.profileId}`,
            };
        },
        resolveInstallableCommand: resolveHostingInstallableCommand,
        runCommand: runHostingCommand,
        resolveScmHostingProviderRegistry,
    };
    return Object.freeze(services);
}
