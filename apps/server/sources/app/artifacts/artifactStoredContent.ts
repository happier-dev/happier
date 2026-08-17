import {
    isPlainArtifactDataKeyMarker,
    isPlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import { z } from "zod";

import type { EffectiveAccountEncryptionMode } from "@/app/encryption/accountEncryptionMode";
import { readEncryptionFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { decryptString, encryptString } from "@/modules/encrypt";

const ArtifactDbSealedContentV1Schema = z.object({
    t: z.literal("sealed_v1"),
    c: z.string().min(1),
}).strict();

type ArtifactContentField = "header" | "body";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

function artifactStoragePath(params: Readonly<{
    accountId: string;
    artifactId: string;
    field: ArtifactContentField;
}>): string[] {
    return ["storage", "artifact", params.accountId, params.artifactId, params.field, "v1"];
}

function isPlainStoredContent(bytes: Uint8Array): boolean {
    return isPlainArtifactStoredContent(
        privacyKit.encodeBase64(copyBytes(bytes)),
    );
}

export function isPlainArtifactDataKeyBytes(bytes: Uint8Array): boolean {
    return isPlainArtifactDataKeyMarker(privacyKit.encodeBase64(copyBytes(bytes)));
}

export function artifactStoredContentMatchesAccountMode(params: Readonly<{
    mode: EffectiveAccountEncryptionMode;
    header: Uint8Array;
    body: Uint8Array;
    dataEncryptionKey: Uint8Array;
}>): boolean {
    const plain = isPlainArtifactDataKeyBytes(params.dataEncryptionKey);
    if (params.mode === "plain") {
        return plain
            && isPlainStoredContent(params.header)
            && isPlainStoredContent(params.body);
    }
    return !plain
        && !isPlainStoredContent(params.header)
        && !isPlainStoredContent(params.body);
}

export function artifactUpdateMatchesStoredMode(params: Readonly<{
    dataEncryptionKey: Uint8Array;
    header?: Uint8Array;
    body?: Uint8Array;
}>): boolean {
    if (isPlainArtifactDataKeyBytes(params.dataEncryptionKey)) {
        return (!params.header || isPlainStoredContent(params.header))
            && (!params.body || isPlainStoredContent(params.body));
    }
    return (!params.header || !isPlainStoredContent(params.header))
        && (!params.body || !isPlainStoredContent(params.body));
}

export function storePlainArtifactDbBytes(params: Readonly<{
    accountId: string;
    artifactId: string;
    field: ArtifactContentField;
    content: Uint8Array;
}>): Uint8Array<ArrayBuffer> | null {
    if (!isPlainStoredContent(params.content)) return null;

    if (readEncryptionFeatureEnv(process.env).plainAccountArtifactsAtRest === "none") {
        return copyBytes(params.content);
    }

    const plaintext = new TextDecoder().decode(params.content);
    const ciphertext = encryptString(artifactStoragePath(params), plaintext);
    const wrapper = JSON.stringify({
        t: "sealed_v1",
        c: privacyKit.encodeBase64(copyBytes(ciphertext)),
    });
    return new TextEncoder().encode(wrapper);
}

export function openArtifactStoredContentBytes(params: Readonly<{
    accountId: string;
    artifactId: string;
    field: ArtifactContentField;
    dataEncryptionKey: Uint8Array;
    content: Uint8Array;
}>): Uint8Array<ArrayBuffer> | null {
    if (!isPlainArtifactDataKeyBytes(params.dataEncryptionKey)) {
        return copyBytes(params.content);
    }
    if (isPlainStoredContent(params.content)) {
        return copyBytes(params.content);
    }

    try {
        const wrapper = ArtifactDbSealedContentV1Schema.safeParse(
            JSON.parse(new TextDecoder().decode(params.content)),
        );
        if (!wrapper.success) return null;

        const ciphertext = privacyKit.decodeBase64(wrapper.data.c);
        const plaintext = decryptString(
            artifactStoragePath(params),
            copyBytes(ciphertext),
        );
        const opened = new TextEncoder().encode(plaintext);
        return isPlainStoredContent(opened) ? opened : null;
    } catch {
        return null;
    }
}

export function openArtifactStoredContentPair(params: Readonly<{
    accountId: string;
    artifactId: string;
    dataEncryptionKey: Uint8Array;
    header: Uint8Array;
    body: Uint8Array;
}>): Readonly<{
    header: Uint8Array<ArrayBuffer>;
    body: Uint8Array<ArrayBuffer>;
}> | null {
    const header = openArtifactStoredContentBytes({
        ...params,
        field: "header",
        content: params.header,
    });
    if (!header) return null;
    const body = openArtifactStoredContentBytes({
        ...params,
        field: "body",
        content: params.body,
    });
    return body ? { header, body } : null;
}
