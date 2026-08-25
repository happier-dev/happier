import {
    StoredJsonContentEnvelopeSchema,
    type StoredJsonContentEnvelope,
} from "@happier-dev/protocol";

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { decryptString, encryptString } from "@/modules/encrypt";

/**
 * One owner for how an Account-scoped connected-account content envelope is written
 * into a database column.
 *
 * An E2EE Account's envelope is already ciphertext the server cannot open, so it is
 * stored as-is. A plain Account's envelope is the readable value, so it is sealed
 * with the server's at-rest key under the caller's domain-separated path unless the
 * deployment turned plain-account credential sealing off. The sealed form never
 * leaves this module: readers get the canonical envelope back.
 *
 * Every connected-account store that persists credential material shares this owner
 * so a new one cannot quietly store in the clear what its siblings seal.
 */
type StoredContentAtRestContainerV1 =
    | Readonly<{
        v: 1;
        storage: "json_v1";
        content: StoredJsonContentEnvelope;
    }>
    | Readonly<{
        v: 1;
        storage: "server_sealed_json_v1";
        ciphertext: string;
    }>;

export function encodeAccountContentForAtRestStorage(params: Readonly<{
    accountMode: "plain" | "e2ee";
    keyPath: string[];
    content: StoredJsonContentEnvelope;
}>): string {
    const content = StoredJsonContentEnvelopeSchema.parse(params.content);
    const json = JSON.stringify(content);
    const shouldServerSeal = params.accountMode === "plain"
        && readEncryptionFeatureEnv(process.env).plainAccountCredentialsAtRest
            !== "none";
    const container: StoredContentAtRestContainerV1 = shouldServerSeal
        ? {
            v: 1,
            storage: "server_sealed_json_v1",
            ciphertext: Buffer.from(encryptString(
                params.keyPath,
                json,
            )).toString("base64"),
        }
        : {
            v: 1,
            storage: "json_v1",
            content,
        };
    return JSON.stringify(container);
}

export class AccountContentAtRestStorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AccountContentAtRestStorageError";
    }
}

export function decodeAccountContentFromAtRestStorage(params: Readonly<{
    keyPath: string[];
    value: string;
}>): StoredJsonContentEnvelope {
    const raw = JSON.parse(params.value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AccountContentAtRestStorageError(
            "Invalid stored connected-account content envelope",
        );
    }
    const container = raw as Partial<StoredContentAtRestContainerV1>;
    if (container.v !== 1) {
        throw new AccountContentAtRestStorageError(
            "Unsupported stored connected-account content envelope",
        );
    }
    if (container.storage === "json_v1") {
        return StoredJsonContentEnvelopeSchema.parse(container.content);
    }
    if (
        container.storage === "server_sealed_json_v1"
        && typeof container.ciphertext === "string"
    ) {
        const opened = decryptString(
            params.keyPath,
            Buffer.from(container.ciphertext, "base64"),
        );
        return StoredJsonContentEnvelopeSchema.parse(JSON.parse(opened));
    }
    throw new AccountContentAtRestStorageError(
        "Unsupported stored connected-account content envelope",
    );
}
