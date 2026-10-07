import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
} from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initEncrypt } from "@/modules/encrypt";

import { artifactProvenanceMatchesAccountMode, openArtifactProvenanceBytes, openArtifactStoredContentBytes,
    openArtifactStoredContentPair, storePlainArtifactDbBytes } from "./artifactStoredContent";

const plainKey = privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER);
const contentBytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));
const context = { accountId: "account-1", artifactId: "artifact-1", mode: "plain" as const, dataEncryptionKey: plainKey };

beforeAll(async () => {
    vi.stubEnv("HANDY_MASTER_SECRET", "artifact-stored-content-test");
    vi.stubEnv("HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST", "server_sealed");
    await initEncrypt();
});
afterAll(() => vi.unstubAllEnvs());

describe("stored Artifact readers", () => {
    it("opens additive sealed envelopes while retaining ciphertext and storage identity validation", () => {
        const content = contentBytes({ title: "stored" });
        const sealed = storePlainArtifactDbBytes({ ...context, field: "header", content })!;
        const wrapper = JSON.parse(new TextDecoder().decode(sealed));
        const persisted = new TextEncoder().encode(JSON.stringify({ ...wrapper, future: { version: 2 } }));
        expect(openArtifactStoredContentBytes({ ...context, field: "header", content: persisted })).toEqual(content);
        expect(openArtifactStoredContentBytes({ ...context, artifactId: "other", field: "header", content: persisted })).toBeNull();
        expect(openArtifactStoredContentBytes({ ...context, field: "header",
            content: new TextEncoder().encode(JSON.stringify({ ...wrapper, c: 42 })) })).toBeNull();
        expect(openArtifactStoredContentBytes({ ...context, mode: "e2ee", field: "header", content: persisted })).toBeNull();
    });

    it("opens additive private metadata without relaxing revision binding or new-write admission", () => {
        const metadata = { v: 1, artifactId: context.artifactId, bodyVersion: 3,
            provenance: { savedBy: { kind: "person", accountId: context.accountId, future: true }, future: true }, future: true };
        const content = contentBytes(metadata);
        const input = { ...context, bodyVersion: 3, provenanceDataEncryptionKey: null, content };
        expect(openArtifactProvenanceBytes(input)).toEqual(content);
        const sealed = storePlainArtifactDbBytes({ ...context, field: "provenance", content })!;
        expect(openArtifactProvenanceBytes({ ...input, content: sealed })).toEqual(content);
        expect(openArtifactProvenanceBytes({ ...input, artifactId: "other" })).toBeNull();
        expect(openArtifactProvenanceBytes({ ...input, bodyVersion: 4 })).toBeNull();
        expect(openArtifactProvenanceBytes({ ...input, mode: "e2ee" })).toBeNull();
        expect(openArtifactProvenanceBytes({ ...input, content: contentBytes({ ...metadata, bodyVersion: "3" }) })).toBeNull();
        expect(artifactProvenanceMatchesAccountMode({ ...input, provenance: content })).toBe(false);
        const canonical = contentBytes({ v: 1, artifactId: context.artifactId, bodyVersion: 3,
            provenance: { savedBy: { kind: "person", accountId: context.accountId } } });
        expect(artifactProvenanceMatchesAccountMode({ ...input, provenance: canonical })).toBe(true);
    });
});

describe("openArtifactStoredContentPair", () => {
    it("rejects stored content whose key marker disagrees with the persisted Account mode", () => {
        const opened = openArtifactStoredContentPair({
            accountId: "account-1",
            artifactId: "artifact-1",
            mode: "e2ee",
            dataEncryptionKey: Buffer.from(
                ARTIFACT_PLAIN_DATA_KEY_MARKER,
                "base64",
            ),
            header: Buffer.from(
                encodePlainArtifactStoredContent({ title: "plain" }),
                "base64",
            ),
            body: Buffer.from(
                encodePlainArtifactStoredContent({ body: "plain" }),
                "base64",
            ),
        });

        expect(opened).toBeNull();
    });

    it("rejects encrypted stored content in a persisted plain Account", () => {
        const opened = openArtifactStoredContentPair({
            accountId: "account-1",
            artifactId: "artifact-1",
            mode: "plain",
            dataEncryptionKey: Buffer.from("encrypted-key"),
            header: Buffer.from("encrypted-header"),
            body: Buffer.from("encrypted-body"),
        });

        expect(opened).toBeNull();
    });
});
