import {
    ConnectedServiceCredentialRecordV1Schema,
    openConnectedServiceCredentialCiphertext,
    type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';
import type {
    ScmHostingProviderRuntimeCommandResult,
    ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk';

import { ApiClient } from '@/api/api';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { getAzDepStatus } from '@/capabilities/deps/az';
import { getGhDepStatus } from '@/capabilities/deps/gh';
import { BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from '@/daemon/connectedServices/descriptors/bitbucket';
import { readCredentials, type Credentials } from '@/persistence';
import {
    resolveScmHostingBasicAuthMaterialization,
    resolveScmHostingTokenMaterialization,
} from '@/scm/hostingProviders/auth';

const GITHUB_CONNECTED_ACCOUNT_SERVICE_ID = 'github';
const DEFAULT_CONNECTED_SERVICE_PROFILE_ID = 'default';

type ConnectedServicesCredentialApi = Pick<
    Awaited<ReturnType<typeof ApiClient.create>>,
    'getConnectedServiceCredentialPlain' | 'getConnectedServiceCredentialSealed' | 'listConnectedServiceProfiles'
>;

type RuntimeServicesDeps = Readonly<{
    readCredentials: () => Promise<Credentials | null>;
    createApi: (credentials: Credentials) => Promise<ConnectedServicesCredentialApi>;
    getGhDepStatus: typeof getGhDepStatus;
    runCommand: (input: Readonly<{
        binPath: string;
        args: readonly string[];
        timeoutMs: number;
        env?: Readonly<Record<string, string>>;
    }>) => Promise<ScmHostingProviderRuntimeCommandResult>;
    getAzDepStatus?: typeof getAzDepStatus;
}>;

function credentialMaterial(credentials: Credentials) {
    return credentials.encryption.type === 'legacy'
        ? { type: 'legacy' as const, secret: credentials.encryption.secret }
        : { type: 'dataKey' as const, machineKey: credentials.encryption.machineKey };
}

async function readCredentialRecord(input: Readonly<{
    api: ConnectedServicesCredentialApi;
    credentials: Credentials;
    serviceId: typeof GITHUB_CONNECTED_ACCOUNT_SERVICE_ID | typeof BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID;
    profileId: string;
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
    const plain = await input.api.getConnectedServiceCredentialPlain({
        serviceId: input.serviceId,
        profileId: input.profileId,
    }).catch(() => null);
    if (plain?.content.v) {
        return plain.content.v;
    }

    const sealed = await input.api.getConnectedServiceCredentialSealed({
        serviceId: input.serviceId,
        profileId: input.profileId,
    }).catch(() => null);
    if (!sealed) return null;

    const opened = openConnectedServiceCredentialCiphertext({
        material: credentialMaterial(input.credentials),
        ciphertext: sealed.sealed.ciphertext,
    });
    const parsed = ConnectedServiceCredentialRecordV1Schema.safeParse(opened?.value);
    return parsed.success ? parsed.data : null;
}

async function listProfileIds(input: Readonly<{
    api: ConnectedServicesCredentialApi;
    serviceId: typeof GITHUB_CONNECTED_ACCOUNT_SERVICE_ID | typeof BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID;
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
    serviceId: typeof GITHUB_CONNECTED_ACCOUNT_SERVICE_ID | typeof BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID;
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
        readCredentials,
        createApi: (credentials) => ApiClient.create(credentials),
        getAzDepStatus,
        getGhDepStatus,
        runCommand: (input) =>
            runCliCommandBestEffort({
                resolvedPath: input.binPath,
                args: [...input.args],
                timeoutMs: input.timeoutMs,
                ...(input.env ? { env: input.env } : {}),
            }),
    };
}

export function createScmHostingProviderRuntimeServices(
    deps: RuntimeServicesDeps = createDefaultDeps(),
): ScmHostingProviderRuntimeServices {
    return Object.freeze({
        async resolveScmHostingTokenMaterialization(input) {
            const records = await readConnectedServiceCredentialRecords({
                serviceId: GITHUB_CONNECTED_ACCOUNT_SERVICE_ID,
                profileId: input.profileId,
            }, deps);
            const result = resolveScmHostingTokenMaterialization({
                kind: input.kind,
                providerId: input.providerId,
                host: input.host,
                ...(input.profileId ? { profileId: input.profileId } : {}),
                records,
            });
            if (result.kind !== 'available') return result;
            return {
                kind: 'available',
                token: result.token,
                profileKey: `${result.serviceId}:${result.profileId}`,
            };
        },
        async resolveScmHostingBasicAuthMaterialization(input) {
            const records = await readConnectedServiceCredentialRecords({
                serviceId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
                profileId: input.profileId,
            }, deps);
            const result = resolveScmHostingBasicAuthMaterialization({
                kind: input.kind,
                providerId: input.providerId,
                host: input.host,
                ...(input.profileId ? { profileId: input.profileId } : {}),
                records,
            });
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
                const status = await deps.getAzDepStatus?.({ onlyIfInstalled: true });
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
            const status = await deps.getGhDepStatus({ onlyIfInstalled: true });
            if (!status.installed || !status.binPath || !status.resolvedSource) {
                return { kind: 'missing' };
            }
            return {
                kind: 'available',
                source: status.resolvedSource,
                binPath: status.binPath,
            };
        },
        runCommand: deps.runCommand,
    });
}
