import type { ConnectedServiceId } from "@happier-dev/protocol";

import {
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountServiceDigest,
    resolveLegacyQualifiedConnectedAccountService,
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../qualifiedConnectedAccounts/identity";

export function createLegacyCredentialFixtureIdentity(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    credentialKind?: "oauth" | "token";
}>) {
    return resolveLegacyServiceAccountTokenIdentityFields(params);
}

export function createLegacyGroupFixtureIdentity(params: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
}>) {
    const service = resolveLegacyQualifiedConnectedAccountService(
        params.serviceId,
    );
    return {
        servicePluginId: service.pluginId,
        serviceLocalId: service.localId,
        qualifiedServiceDigest:
            createQualifiedConnectedAccountServiceDigest(service),
        qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({
            service,
            groupId: params.groupId,
        }),
    };
}

export function createLegacyGroupMemberFixtureIdentity(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId: string;
    credentialId: string;
    credentialKind?: "oauth" | "token";
}>) {
    const credential = createLegacyCredentialFixtureIdentity(params);
    return {
        credentialId: params.credentialId,
        qualifiedServiceDigest: credential.qualifiedServiceDigest,
        qualifiedGroupDigest: createLegacyGroupFixtureIdentity(params)
            .qualifiedGroupDigest,
        qualifiedIdentityDigest: credential.qualifiedIdentityDigest,
    };
}
