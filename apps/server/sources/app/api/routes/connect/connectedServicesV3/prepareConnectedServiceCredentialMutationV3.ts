import {
    ConnectedServiceCredentialRecordV1Schema,
    assertConnectedServiceCredentialRecordBinding,
    type ConnectedServiceId,
} from "@happier-dev/protocol";

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { encryptString } from "@/modules/encrypt";

import { encodeUtf8Bytes } from "./bytesCodec";
import type { ConnectedServiceCredentialMetadataV3 } from "./credentialMetadataV3";

const MAX_CREDENTIAL_JSON_CHARS = 220_000;

export class ConnectedServiceCredentialV3PreparationError extends Error {
    constructor(readonly reason: "invalid_params" | "invalid_binding") {
        super(`Connected service credential preparation failed: ${reason}`);
        this.name = "ConnectedServiceCredentialV3PreparationError";
    }
}

export function prepareConnectedServiceCredentialMutationV3(params: Readonly<{
    accountId: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    record: unknown;
    env?: NodeJS.ProcessEnv;
}>): Readonly<{
    token: Uint8Array<ArrayBuffer>;
    metadata: ConnectedServiceCredentialMetadataV3;
    expiresAt: Date | null;
    incomingIdentity: Readonly<{
        providerEmail: string | null;
        providerAccountId: string | null;
    }>;
}> {
    const parsed =
        ConnectedServiceCredentialRecordV1Schema.safeParse(params.record);
    if (!parsed.success) {
        throw new ConnectedServiceCredentialV3PreparationError(
            "invalid_params",
        );
    }
    const record = parsed.data;
    try {
        assertConnectedServiceCredentialRecordBinding({
            binding: {
                serviceId: params.serviceId,
                profileId: params.profileId,
            },
            record,
        });
    } catch {
        throw new ConnectedServiceCredentialV3PreparationError(
            "invalid_binding",
        );
    }

    const json = JSON.stringify(record);
    if (json.length > MAX_CREDENTIAL_JSON_CHARS) {
        throw new ConnectedServiceCredentialV3PreparationError(
            "invalid_params",
        );
    }

    const atRest =
        readEncryptionFeatureEnv(params.env ?? process.env)
            .plainAccountCredentialsAtRest === "none"
            ? "none"
            : "server_sealed";
    const storage =
        atRest === "server_sealed"
            ? "server_sealed_json_v1"
            : "plain_json_v1";
    const providerEmail =
        record.kind === "oauth"
            ? record.oauth?.providerEmail ?? null
            : record.token?.providerEmail ?? null;
    const providerAccountId =
        record.kind === "oauth"
            ? record.oauth?.providerAccountId ?? null
            : record.token?.providerAccountId ?? null;
    const metadata: ConnectedServiceCredentialMetadataV3 = {
        v: 3,
        storage,
        kind: record.kind,
        providerEmail,
        providerAccountId,
    };
    const keyPath = [
        "storage",
        "connect_credential",
        params.accountId,
        params.serviceId,
        params.profileId,
        "v1",
    ];

    return {
        token:
            atRest === "server_sealed"
                ? encryptString(keyPath, json) as Uint8Array<ArrayBuffer>
                : encodeUtf8Bytes(json),
        metadata,
        expiresAt:
            typeof record.expiresAt === "number"
            && Number.isFinite(record.expiresAt)
                ? new Date(record.expiresAt)
                : null,
        incomingIdentity: {
            providerEmail,
            providerAccountId,
        },
    };
}
