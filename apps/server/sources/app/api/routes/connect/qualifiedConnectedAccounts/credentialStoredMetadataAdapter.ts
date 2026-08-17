import type {
    ConnectedServiceCredentialHealthV1,
    QualifiedConnectedAccountCredentialMetadataV4,
    StoredJsonContentEnvelope,
} from "@happier-dev/protocol";
import {
    ConnectedServiceCredentialRecordV1Schema,
    ConnectedServiceIdSchema,
    assertConnectedServiceCredentialRecordBinding,
} from "@happier-dev/protocol";

import { decryptString } from "@/modules/encrypt";
import {
    deriveConnectedServiceCredentialStatus,
    parseQualifiedConnectedServiceCredentialStoredMetadataV4,
} from "../credentialHealthMetadata";
import {
    isConnectedServiceCredentialMetadataV2,
    normalizeConnectedServiceCredentialMetadataV2,
} from "../connectedServicesV2/credentialMetadataV2";
import {
    isConnectedServiceCredentialMetadataV3,
    normalizeConnectedServiceCredentialMetadataV3,
} from "../connectedServicesV3/credentialMetadataV3";
import {
    resolveConnectedServiceCredentialRevision,
} from "../credentials/credentialRevision";
import {
    decodeCredentialTokenString,
} from "../connectedServicesV2/credentialTokenCodec";

type CredentialStatus = ReturnType<
    typeof deriveConnectedServiceCredentialStatus
>;

type QualifiedConnectedAccountStoredRevisionSemantics =
    | Readonly<{
        revisionSemantics: "revisioned";
        credentialRevision: string;
    }>
    | Readonly<{
        revisionSemantics: "legacy_unfenced";
        credentialRevision: null;
    }>;

export type QualifiedConnectedAccountStoredMetadataProjection =
    QualifiedConnectedAccountStoredRevisionSemantics & Readonly<{
    format: "v4" | "legacy_v2" | "legacy_v3" | "legacy_unknown";
    presentation: QualifiedConnectedAccountCredentialMetadataV4;
    kind: "oauth" | "token" | null;
    health: ConnectedServiceCredentialHealthV1 | null;
    status: CredentialStatus;
}>;

function resolveStoredCredentialRevisionSemantics(
    metadata: unknown,
): QualifiedConnectedAccountStoredRevisionSemantics {
    const credentialRevision = resolveConnectedServiceCredentialRevision({ metadata });
    return credentialRevision === null
        ? { revisionSemantics: "legacy_unfenced", credentialRevision: null }
        : { revisionSemantics: "revisioned", credentialRevision };
}

function legacyPresentation(metadata: Readonly<{
    providerEmail?: string | null;
    providerAccountId?: string | null;
}>): QualifiedConnectedAccountCredentialMetadataV4 {
    const hasProviderIdentity =
        metadata.providerEmail !== undefined
        || metadata.providerAccountId !== undefined;
    return {
        ...(hasProviderIdentity
            ? {
                providerIdentity: {
                    ...(metadata.providerEmail !== undefined
                        ? { email: metadata.providerEmail }
                        : {}),
                    ...(metadata.providerAccountId !== undefined
                        ? { accountId: metadata.providerAccountId }
                        : {}),
                },
            }
            : {}),
        scopes: [],
    };
}

export function resolveQualifiedConnectedAccountStoredMetadata(
    params: Readonly<{ rowId: string; metadata: unknown }>,
): QualifiedConnectedAccountStoredMetadataProjection {
    if (
        params.metadata
        && typeof params.metadata === "object"
        && "v" in params.metadata
        && params.metadata.v === 4
    ) {
        const stored =
            parseQualifiedConnectedServiceCredentialStoredMetadataV4(
                params.metadata,
            );
        return {
            format: "v4",
            revisionSemantics: "revisioned",
            credentialRevision: stored.credentialRevision,
            presentation: stored.values,
            kind: null,
            health: stored.health ?? null,
            status: deriveConnectedServiceCredentialStatus(stored),
        };
    }
    if (isConnectedServiceCredentialMetadataV2(params.metadata)) {
        const metadata =
            normalizeConnectedServiceCredentialMetadataV2(params.metadata);
        return {
            format: "legacy_v2",
            ...resolveStoredCredentialRevisionSemantics(metadata),
            presentation: legacyPresentation(metadata),
            kind: metadata.kind,
            health: metadata.health ?? null,
            status: deriveConnectedServiceCredentialStatus(metadata),
        };
    }
    if (isConnectedServiceCredentialMetadataV3(params.metadata)) {
        const metadata =
            normalizeConnectedServiceCredentialMetadataV3(params.metadata);
        return {
            format: "legacy_v3",
            ...resolveStoredCredentialRevisionSemantics(metadata),
            presentation: legacyPresentation(metadata),
            kind: metadata.kind,
            health: metadata.health ?? null,
            status: deriveConnectedServiceCredentialStatus(metadata),
        };
    }
    return {
        format: "legacy_unknown",
        ...resolveStoredCredentialRevisionSemantics(params.metadata),
        presentation: { scopes: [] },
        kind: null,
        health: null,
        status: "needs_reauth",
    };
}

function legacyPlainCredentialStorageKeyPath(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
}>): string[] {
    return [
        "storage",
        "connect_credential",
        params.accountId,
        params.serviceId,
        params.profileId,
        "v1",
    ];
}

export function decodeLegacyQualifiedConnectedAccountCredentialEnvelope(
    params: Readonly<{
        accountId: string;
        serviceId: string;
        profileId: string;
        token: Uint8Array;
        metadata: unknown;
    }>,
): StoredJsonContentEnvelope | null {
    const serviceId = ConnectedServiceIdSchema.parse(params.serviceId);
    if (isConnectedServiceCredentialMetadataV2(params.metadata)) {
        return {
            t: "encrypted",
            c: decodeCredentialTokenString(params.token),
        };
    }
    if (!isConnectedServiceCredentialMetadataV3(params.metadata)) {
        return null;
    }
    const metadata =
        normalizeConnectedServiceCredentialMetadataV3(params.metadata);
    const json = metadata.storage === "server_sealed_json_v1"
        ? decryptString(
            legacyPlainCredentialStorageKeyPath(params),
            new Uint8Array(params.token),
        )
        : new TextDecoder().decode(params.token);
    const record = ConnectedServiceCredentialRecordV1Schema.parse(
        JSON.parse(json),
    );
    assertConnectedServiceCredentialRecordBinding({
        binding: {
            serviceId,
            profileId: params.profileId,
        },
        record,
    });
    return { t: "plain", v: record };
}
