import { StoredJsonContentEnvelopeSchema, type StoredJsonContentEnvelope } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';

import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { decryptString, encryptString } from "@/modules/encrypt";

/**
 * One owner for how a sensitive content envelope is written
 * into a database column.
 *
 * An E2EE envelope is already ciphertext the server cannot open, so it is
 * stored as-is. A plain envelope is the readable value, so it is sealed
 * with the server's at-rest key under the caller's domain-separated path unless the
 * deployment turned plain-account credential sealing off. The sealed form never
 * leaves this module: readers get the canonical envelope back.
 *
 * Sensitive-content stores share this owner
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

type ContentSchema<TEnvelope extends StoredJsonContentEnvelope> = Readonly<{
    parse(value: unknown): TEnvelope;
}>;

export function encodeSensitiveContentForAtRestStorage(params: Readonly<{
    contentMode: "plain" | "e2ee";
    keyPath: string[];
    content: StoredJsonContentEnvelope;
    /** A domain envelope can retain its declared value-free header fields. */
    contentSchema?: ContentSchema<StoredJsonContentEnvelope>;
}>): string {
    const content = (params.contentSchema ?? StoredJsonContentEnvelopeSchema).parse(params.content);
    const json = JSON.stringify(content);
    const shouldServerSeal = params.contentMode === "plain"
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

export class SensitiveContentAtRestStorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AccountContentAtRestStorageError";
    }
}

type DecodeParams = Readonly<{
    keyPath: string[];
    value: string;
}>;

export function decodeSensitiveContentFromAtRestStorage<TEnvelope extends StoredJsonContentEnvelope>(
    params: DecodeParams & Readonly<{ contentSchema: ContentSchema<TEnvelope> }>,
): TEnvelope;
export function decodeSensitiveContentFromAtRestStorage(params: DecodeParams): StoredJsonContentEnvelope;
export function decodeSensitiveContentFromAtRestStorage(params: DecodeParams & Readonly<{
    contentSchema?: ContentSchema<StoredJsonContentEnvelope>;
}>): StoredJsonContentEnvelope {
    const schema = params.contentSchema ?? StoredJsonContentEnvelopeSchema;
    const raw = JSON.parse(params.value) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new SensitiveContentAtRestStorageError(
            "Invalid stored connected-account content envelope",
        );
    }
    const container = raw as Partial<StoredContentAtRestContainerV1>;
    if (container.v !== 1) {
        throw new SensitiveContentAtRestStorageError(
            "Unsupported stored connected-account content envelope",
        );
    }
    if (container.storage === "json_v1") {
        return schema.parse(container.content);
    }
    if (
        container.storage === "server_sealed_json_v1"
        && typeof container.ciphertext === "string"
    ) {
        const opened = decryptString(
            params.keyPath,
            Buffer.from(container.ciphertext, "base64"),
        );
        return schema.parse(JSON.parse(opened));
    }
    throw new SensitiveContentAtRestStorageError(
        "Unsupported stored connected-account content envelope",
    );
}
