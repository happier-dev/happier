import {
    type ConnectedServiceCredentialHealthV1,
    type ConnectedServiceCredentialRevisionV1,
    type ConnectedServiceId,
    type QualifiedConnectedAccountGroupV4,
    type QualifiedConnectedAccountProfileV4,
} from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { collectLegacyConnectedServiceVendorKeysFromRows } from "../connect/legacyConnectedServiceVendors";
import {
    listAllQualifiedConnectedAccountsForLegacyProjectionInTx,
} from "../connect/qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyServiceIdForQualifiedConnectedAccountService,
} from "../connect/qualifiedConnectedAccounts/identity";
import {
    listAllQualifiedConnectedAccountGroupsForLegacyProjectionInTx,
} from "../connect/qualifiedConnectedAccounts/groupRepository";

type ConnectedServiceProfileStatus =
    | "connected"
    | "refreshing"
    | "needs_reauth"
    | "refresh_failed_retryable";

export type ConnectedServiceProfileProjection = Readonly<{
    profileId: string;
    status: ConnectedServiceProfileStatus;
    kind: "oauth" | "token" | null;
    providerEmail: string | null;
    providerAccountId: string | null;
    expiresAt: number | null;
    lastUsedAt: number | null;
    health: ConnectedServiceCredentialHealthV1 | null;
}>;

export type ConnectedServiceGroupProjection = Readonly<{
    groupId: string;
    displayName: string | null;
    activeProfileId: string | null;
    generation: number;
    memberProfileIds: string[];
}>;

export type ConnectedServiceServiceProjection = Readonly<{
    serviceId: ConnectedServiceId;
    profiles: ConnectedServiceProfileProjection[];
    groups: ConnectedServiceGroupProjection[];
}>;

export type AccountConnectedServicesProjection = Readonly<{
    connectedServices: string[];
    connectedServicesV2: ConnectedServiceServiceProjection[];
    connectedServiceCredentialRevisionsV1: Array<Readonly<{
        serviceId: ConnectedServiceId;
        profileId: string;
        credentialRevision: ConnectedServiceCredentialRevisionV1;
    }>>;
    connectedAccountsV4: QualifiedConnectedAccountProfileV4[];
    connectedAccountGroupsV4: QualifiedConnectedAccountGroupV4[];
}>;

type AccountConnectedServicesProjectionStorage = Pick<Tx, "serviceAccountToken" | "connectedServiceAuthGroup">;

type QualifiedConnectedAccountLegacyProjection = Awaited<
    ReturnType<
        typeof listAllQualifiedConnectedAccountsForLegacyProjectionInTx
    >
>[number];

type QualifiedConnectedAccountGroupLegacyProjection = Awaited<
    ReturnType<
        typeof listAllQualifiedConnectedAccountGroupsForLegacyProjectionInTx
    >
>[number];

function addAccountProfilesToServices(params: Readonly<{
    accounts: ReadonlyArray<QualifiedConnectedAccountLegacyProjection>;
    servicesById: Map<ConnectedServiceId, ConnectedServiceServiceProjection>;
}>): void {
    for (const projection of params.accounts) {
        const account = projection.account;
        const serviceId =
            resolveLegacyServiceIdForQualifiedConnectedAccountService(
                account.ref.service,
            );
        if (!serviceId) continue;
        const existing = params.servicesById.get(serviceId) ?? {
            serviceId,
            profiles: [],
            groups: [],
        };
        existing.profiles.push({
            profileId: account.ref.accountId,
            status: account.status,
            kind: projection.legacyCredentialKind,
            providerEmail: account.providerIdentity?.email ?? null,
            providerAccountId: account.providerIdentity?.accountId ?? null,
            expiresAt: account.expiresAt ?? null,
            lastUsedAt: account.lastUsedAt ?? null,
            health: projection.health,
        });
        params.servicesById.set(serviceId, existing);
    }
}

function addAuthGroupsToServices(params: Readonly<{
    groups: ReadonlyArray<QualifiedConnectedAccountGroupLegacyProjection>;
    servicesById: Map<ConnectedServiceId, ConnectedServiceServiceProjection>;
}>): void {
    for (const projection of params.groups) {
        const group = projection.group;
        const serviceId =
            resolveLegacyServiceIdForQualifiedConnectedAccountService(
                group.ref.service,
            );
        if (!serviceId) continue;
        const existing = params.servicesById.get(serviceId) ?? {
            serviceId,
            profiles: [],
            groups: [],
        };
        const memberProfileIds = group.members
            .filter((member) => member.enabled)
            .map((member) => member.connectedAccountId);
        existing.groups.push({
            groupId: group.ref.groupId,
            displayName: group.displayName,
            activeProfileId:
                projection.activeProfileId !== null
                && memberProfileIds.includes(projection.activeProfileId)
                    ? projection.activeProfileId
                    : null,
            generation: group.generation,
            memberProfileIds,
        });
        params.servicesById.set(serviceId, existing);
    }
}

export async function buildAccountConnectedServicesProjection(params: Readonly<{
    tx: AccountConnectedServicesProjectionStorage;
    accountId: string;
    includeGroups: boolean;
}>): Promise<AccountConnectedServicesProjection> {
    const accountProjections =
        await listAllQualifiedConnectedAccountsForLegacyProjectionInTx(
            params.tx,
            { accountId: params.accountId },
        );
    const servicesById = new Map<ConnectedServiceId, ConnectedServiceServiceProjection>();
    addAccountProfilesToServices({
        accounts: accountProjections,
        servicesById,
    });
    const connectedAccountsV4 = accountProjections.map(
        (projection) => projection.account,
    );
    const groupProjections =
        await listAllQualifiedConnectedAccountGroupsForLegacyProjectionInTx(
            params.tx,
            {
                accountId: params.accountId,
            },
        );
    const connectedAccountGroupsV4 = groupProjections.map(
        (projection) => projection.group,
    );

    if (params.includeGroups) {
        addAuthGroupsToServices({
            groups: groupProjections,
            servicesById,
        });
    }

    return {
        connectedServices: collectLegacyConnectedServiceVendorKeysFromRows(
            accountProjections.flatMap(({ account }) => {
                const vendor =
                    resolveLegacyServiceIdForQualifiedConnectedAccountService(
                        account.ref.service,
                    );
                return vendor === null
                    ? []
                    : [{
                        vendor,
                        profileId: account.ref.accountId,
                    }];
            }),
        ),
        connectedServicesV2: Array.from(servicesById.values()),
        connectedServiceCredentialRevisionsV1:
            accountProjections.flatMap((projection) => {
                if (!projection.publishLegacyCredentialRevision) return [];
                const serviceId =
                    resolveLegacyServiceIdForQualifiedConnectedAccountService(
                        projection.account.ref.service,
                    );
                return serviceId === null
                    ? []
                    : [{
                        serviceId,
                        profileId: projection.account.ref.accountId,
                        credentialRevision:
                            projection.account.credentialRevision,
                    }];
        }),
        connectedAccountsV4,
        connectedAccountGroupsV4,
    };
}
