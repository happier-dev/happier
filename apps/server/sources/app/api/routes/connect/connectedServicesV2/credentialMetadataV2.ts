import type { ConnectedServiceCredentialHealthV1 } from "@happier-dev/protocol";
import { hasValidCredentialHealth, parseConnectedServiceCredentialHealth } from "../credentialHealthMetadata";

export type ConnectedServiceCredentialMetadataV2 = Readonly<{
    v: 2;
    format: "account_scoped_v1";
    kind: "oauth" | "token";
    providerEmail?: string | null;
    providerAccountId?: string | null;
    health?: ConnectedServiceCredentialHealthV1;
}>;

export function isConnectedServiceCredentialMetadataV2(raw: unknown): raw is ConnectedServiceCredentialMetadataV2 {
    if (!raw || typeof raw !== "object") return false;
    const rec = raw as any;
    return rec.v === 2
        && rec.format === "account_scoped_v1"
        && (rec.kind === "oauth" || rec.kind === "token")
        && hasValidCredentialHealth(rec.health);
}

export function normalizeConnectedServiceCredentialMetadataV2(
    raw: ConnectedServiceCredentialMetadataV2,
): ConnectedServiceCredentialMetadataV2 {
    return {
        ...raw,
        health: parseConnectedServiceCredentialHealth(raw.health),
    };
}
