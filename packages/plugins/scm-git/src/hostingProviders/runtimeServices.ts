import {
    ConnectedServiceCredentialRecordV1Schema,
    openConnectedServiceCredentialCiphertext,
    type AccountScopedCryptoMaterial,
    type ConnectedServiceCredentialRecordV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeCommandResult,
    ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';
import { readCurrentScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

import {
    resolveScmHostingBasicAuthMaterialization,
    resolveScmHostingBasicAuthServiceId,
    resolveScmHostingTokenServiceId,
    resolveScmHostingTokenMaterialization,
    type ScmHostingAuthMaterializationRegistry,
} from './auth/index.js';

const DEFAULT_CONNECTED_SERVICE_PROFILE_ID = 'default';

export type Credentials = Readonly<{
    token?: string;
    encryption: AccountScopedCryptoMaterial;
}>;

type ConnectedServicesCredentialApi = Pick<
    Readonly<{
        getConnectedServiceCredentialPlain(input: Readonly<{
            serviceId: ConnectedServiceId;
            profileId: string;
        }>): Promise<Readonly<{ content: Readonly<{ v?: unknown }> }> | null>;
        getConnectedServiceCredentialSealed(input: Readonly<{
            serviceId: ConnectedServiceId;
            profileId: string;
        }>): Promise<Readonly<{ sealed: Readonly<{ ciphertext: string }> }> | null>;
        listConnectedServiceProfiles(input: Readonly<{
            serviceId: ConnectedServiceId;
        }>): Promise<Readonly<{ profiles: readonly Readonly<{ profileId: string }>[] }> | null>;
    }>,
    'getConnectedServiceCredentialPlain' | 'getConnectedServiceCredentialSealed' | 'listConnectedServiceProfiles'
>;

export type RuntimeServicesDeps = Readonly<{
    readCredentials: () => Promise<Credentials | null>;
    createApi: (credentials: Credentials) => Promise<ConnectedServicesCredentialApi>;
    getGhDepStatus: (input: Readonly<{ onlyIfInstalled?: boolean }>) => Promise<Readonly<{
        installed: boolean;
        binPath?: string | null;
        resolvedSource?: string | null;
    }>>;
    runCommand: (input: Readonly<{
        binPath: string;
        args: readonly string[];
        timeoutMs: number;
        env?: Readonly<Record<string, string>>;
    }>) => Promise<ScmHostingProviderRuntimeCommandResult>;
    getAzDepStatus?: (input: Readonly<{ onlyIfInstalled?: boolean }>) => Promise<Readonly<{
        installed: boolean;
        binPath?: string | null;
        resolvedSource?: string | null;
    }> | null>;
    resolveAuthMaterializationRegistry?: () => Promise<ScmHostingAuthMaterializationRegistry>;
}>;

async function readCredentialRecord(input: Readonly<{
    api: ConnectedServicesCredentialApi;
    credentials: Credentials;
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
}>, deps: RuntimeServicesDeps): Promise<readonly ConnectedServiceCredentialRecordV1[]> {
    const credentials = await deps.readCredentials().catch(() => null);
    if (!credentials) return [];
    const api = await deps.createApi(credentials);
    const records: ConnectedServiceCredentialRecordV1[] = [];
    for (const profileId of await listProfileIds({ api, serviceId: input.serviceId, profileId: input.profileId })) {
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

function createDefaultDeps(): RuntimeServicesDeps {
    return {
        readCredentials: async () => null,
        createApi: async () => ({
            getConnectedServiceCredentialPlain: async () => null,
            getConnectedServiceCredentialSealed: async () => null,
            listConnectedServiceProfiles: async () => ({ profiles: [] }),
        }),
        getAzDepStatus: async () => null,
        getGhDepStatus: async () => ({ installed: false }),
        resolveAuthMaterializationRegistry: async () => ({}),
        runCommand: async () => ({
            ok: false,
            exitCode: null,
            stdout: '',
            stderr: 'No SCM hosting command runtime is configured.',
        }),
    };
}

export function createScmHostingProviderRuntimeServices(
    deps?: RuntimeServicesDeps,
): ScmHostingProviderRuntimeServices {
    const currentServices = readCurrentScmHostingProviderRuntimeServices();
    if (!deps && currentServices) {
        return currentServices;
    }
    const resolvedDeps = deps ?? createDefaultDeps();
    let authMaterializationRegistryPromise: Promise<ScmHostingAuthMaterializationRegistry> | null = null;
    async function getAuthMaterializationRegistry(): Promise<ScmHostingAuthMaterializationRegistry> {
        authMaterializationRegistryPromise ??= resolvedDeps.resolveAuthMaterializationRegistry?.() ?? Promise.resolve({});
        return authMaterializationRegistryPromise;
    }

    return Object.freeze({
        async resolveScmHostingTokenMaterialization(input) {
            const registry = await getAuthMaterializationRegistry();
            const serviceId = await resolveScmHostingTokenServiceId(input, registry);
            if (!serviceId) {
                return resolveScmHostingTokenMaterialization({ ...input, records: [] }, registry);
            }
            const records = await readConnectedServiceCredentialRecords({
                serviceId,
                profileId: input.profileId,
            }, resolvedDeps);
            const result = await resolveScmHostingTokenMaterialization({
                kind: input.kind,
                providerId: input.providerId,
                host: input.host,
                ...(input.profileId ? { profileId: input.profileId } : {}),
                records,
            }, registry);
            if (result.kind !== 'available') return result;
            return {
                kind: 'available',
                token: result.token,
                profileKey: `${result.serviceId}:${result.profileId}`,
            };
        },
        async resolveScmHostingBasicAuthMaterialization(input) {
            const registry = await getAuthMaterializationRegistry();
            const serviceId = await resolveScmHostingBasicAuthServiceId(input, registry);
            if (!serviceId) {
                return resolveScmHostingBasicAuthMaterialization({ ...input, records: [] }, registry);
            }
            const records = await readConnectedServiceCredentialRecords({
                serviceId,
                profileId: input.profileId,
            }, resolvedDeps);
            const result = await resolveScmHostingBasicAuthMaterialization({
                kind: input.kind,
                providerId: input.providerId,
                host: input.host,
                ...(input.profileId ? { profileId: input.profileId } : {}),
                records,
            }, registry);
            if (result.kind !== 'available') return result;
            return {
                kind: 'available',
                username: result.username,
                password: result.password,
                profileKey: `${result.serviceId}:${result.profileId}`,
            };
        },
        async resolveInstallableCommand(input) {
            if (input.capabilityId === 'dep.az') {
                const status = await resolvedDeps.getAzDepStatus?.({ onlyIfInstalled: true });
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
            const status = await resolvedDeps.getGhDepStatus({ onlyIfInstalled: true });
            if (!status.installed || !status.binPath || !status.resolvedSource) {
                return { kind: 'missing' };
            }
            return {
                kind: 'available',
                source: status.resolvedSource,
                binPath: status.binPath,
            };
        },
        runCommand: resolvedDeps.runCommand,
    });
}
