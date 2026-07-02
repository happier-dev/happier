import type { ConnectedServiceCredentialHealthV1 } from "@happier-dev/protocol";
import { hasValidCredentialHealth, parseConnectedServiceCredentialHealth } from "../credentialHealthMetadata";

export type ConnectedServiceCredentialAtRestStorageV3 =
    | "plain_json_v1"
    | "server_sealed_json_v1";

export type ConnectedServiceCredentialMetadataV3 = Readonly<{
    v: 3;
    storage: ConnectedServiceCredentialAtRestStorageV3;
    kind: "oauth" | "token";
    providerEmail?: string | null;
    providerAccountId?: string | null;
    health?: ConnectedServiceCredentialHealthV1;
}>;

export function isConnectedServiceCredentialMetadataV3(raw: unknown): raw is ConnectedServiceCredentialMetadataV3 {
    if (!raw || typeof raw !== "object") return false;
    const rec = raw as any;
    const storageOk = rec.storage === "plain_json_v1" || rec.storage === "server_sealed_json_v1";
    const kindOk = rec.kind === "oauth" || rec.kind === "token";
    return rec.v === 3 && storageOk && kindOk && hasValidCredentialHealth(rec.health);
}

export function normalizeConnectedServiceCredentialMetadataV3(
    raw: ConnectedServiceCredentialMetadataV3,
): ConnectedServiceCredentialMetadataV3 {
    return {
        ...raw,
        health: parseConnectedServiceCredentialHealth(raw.health),
    };
}
