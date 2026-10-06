import {
    ArtifactBodyEnvelopeV1Schema,
    ArtifactBodyEnvelopeV1StoredSchema,
    ArtifactPrivateRevisionMetadataV1Schema,
    ArtifactPrivateRevisionMetadataV1StoredSchema,
    type ArtifactRevisionProvenanceV1,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    decodePlainArtifactStoredContent,
    encodePlainArtifactStoredContent,
    isPlainArtifactDataKeyMarker,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

import type { ArtifactBody, ArtifactHeader } from './artifactTypes';

export type AccountArtifactStorageMode = 'plain' | 'e2ee';

/**
 * The established generic Artifact transport representation. Consumers own
 * their logical payload schema; this owner supplies only plain/E2EE wrapping.
 */
export type AccountArtifactStoredEnvelope = Readonly<{
    header: string;
    body: string;
    dataEncryptionKey: string;
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
}>;

/** Private metadata has its own random key; content/public-link keys never open it. */
export async function sealArtifactPrivateRevisionMetadata(input: Readonly<{
    mode: AccountArtifactStorageMode; artifactId: string; bodyVersion: number;
    provenance: ArtifactRevisionProvenanceV1; dataKey?: Uint8Array | null;
}>): Promise<string> {
    const metadata = ArtifactPrivateRevisionMetadataV1Schema.parse({ v: 1, artifactId: input.artifactId,
        bodyVersion: input.bodyVersion, provenance: input.provenance });
    if (input.mode === 'plain') return encodePlainArtifactStoredContent(metadata);
    if (!input.dataKey) throw new Error('Artifact private metadata key is unavailable');
    return new ArtifactEncryption(input.dataKey).encryptHeader(metadata);
}

export async function openArtifactPrivateRevisionMetadata(input: Readonly<{
    mode: AccountArtifactStorageMode; artifactId: string; bodyVersion: number;
    provenance?: string | null; dataKey?: Uint8Array | null;
}>): Promise<ArtifactRevisionProvenanceV1 | undefined> {
    if (input.provenance === null || input.provenance === undefined) return undefined;
    if (input.mode === 'e2ee' && !input.dataKey) throw new Error('Artifact private metadata key is unavailable');
    const opened = input.mode === 'plain' ? decodePlainArtifactStoredContent(input.provenance)
        : await new ArtifactEncryption(input.dataKey!).decryptHeaderRaw(input.provenance);
    const metadata = ArtifactPrivateRevisionMetadataV1StoredSchema.parse(opened);
    if (metadata.artifactId !== input.artifactId || metadata.bodyVersion !== input.bodyVersion)
        throw new Error('Artifact private metadata identity mismatch');
    return metadata.provenance;
}

export type AccountArtifactEnvelopeKeySealer = (
    dataKey: Uint8Array,
) => Promise<Uint8Array | null>;

export type AccountArtifactEnvelopeKeyOpener = (
    encryptedDataKey: string,
) => Promise<Uint8Array | null>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArtifactHeader(value: unknown): ArtifactHeader | null {
    return isRecord(value) ? value as ArtifactHeader : null;
}

function parseArtifactBody(value: unknown): ArtifactBody | null {
    if (!isRecord(value)) return null;
    const body = ArtifactBodyEnvelopeV1StoredSchema.safeParse(value);
    return body.success ? body.data : null;
}

/**
 * Produces exactly the existing generic Artifact create envelope. It adds no
 * plugin-specific encryption, persisted key, or transition participant.
 */
export async function createAccountArtifactStoredEnvelope(input: Readonly<{
    mode: AccountArtifactStorageMode;
    header: ArtifactHeader;
    body: ArtifactBody;
    encryptDataEncryptionKey?: AccountArtifactEnvelopeKeySealer;
}>): Promise<AccountArtifactStoredEnvelope | null> {
    try {
        const body = ArtifactBodyEnvelopeV1Schema.parse(input.body);
        if (input.mode === 'plain') {
            return Object.freeze({
                header: encodePlainArtifactStoredContent(input.header),
                body: encodePlainArtifactStoredContent(body),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            });
        }
        if (!input.encryptDataEncryptionKey) return null;
        const dataKey = ArtifactEncryption.generateDataEncryptionKey();
        const encryptedDataKey = await input.encryptDataEncryptionKey(dataKey);
        if (!(encryptedDataKey instanceof Uint8Array)) return null;
        const artifactEncryption = new ArtifactEncryption(dataKey);
        return Object.freeze({
            header: await artifactEncryption.encryptHeader(input.header),
            body: await artifactEncryption.encryptBody(body),
            dataEncryptionKey: encodeBase64(encryptedDataKey, 'base64'),
        });
    } catch {
        return null;
    }
}

/**
 * Opens exactly the current generic Artifact representation for the Account's
 * already-authoritative persisted mode. A marker/mode mismatch is unavailable,
 * never silently reinterpreted as the other representation.
 */
export async function openAccountArtifactStoredEnvelope(input: Readonly<{
    mode: AccountArtifactStorageMode;
    envelope: AccountArtifactStoredEnvelope;
    decryptDataEncryptionKey?: AccountArtifactEnvelopeKeyOpener;
}>): Promise<Readonly<{ header: ArtifactHeader; body: ArtifactBody }> | null> {
    try {
        const isPlain = isPlainArtifactDataKeyMarker(input.envelope.dataEncryptionKey);
        if (input.mode === 'plain') {
            if (!isPlain) return null;
            const header = parseArtifactHeader(
                decodePlainArtifactStoredContent(input.envelope.header),
            );
            const body = parseArtifactBody(
                decodePlainArtifactStoredContent(input.envelope.body),
            );
            return header && body ? Object.freeze({ header, body }) : null;
        }
        if (isPlain || !input.decryptDataEncryptionKey) return null;
        const dataKey = await input.decryptDataEncryptionKey(
            input.envelope.dataEncryptionKey,
        );
        if (!(dataKey instanceof Uint8Array)) return null;
        const artifactEncryption = new ArtifactEncryption(dataKey);
        const [header, body] = await Promise.all([
            artifactEncryption.decryptHeader(input.envelope.header),
            artifactEncryption.decryptBody(input.envelope.body),
        ]);
        return header && body ? Object.freeze({ header, body }) : null;
    } catch {
        return null;
    }
}
