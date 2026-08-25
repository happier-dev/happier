import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import {
    createPluginInstallationManifestPublisherSigningInputV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
} from "@happier-dev/protocol";

const machineFindFirst = vi.hoisted(() => vi.fn());

vi.mock("@/storage/db", () => ({
    db: {
        machine: {
            findFirst: machineFindFirst,
        },
    },
}));

import {
    PluginInstallationPublisherProofError,
    verifyPluginInstallationPublisherBodyBinding,
    verifyPluginInstallationPublisherHeader,
    verifyPluginInstallationPublisherHeaderBeforeBody,
} from "./publisherProof";

const ACCOUNT_ID = "account-1";
const MACHINE_ID = "machine-1";
const INSTALLATION_ID = "installation-1";
const PATH = "/v1/automations/events/admit";

function createSignedPublisherHeader(params: Readonly<{
    keyPair: tweetnacl.SignKeyPair;
    body: unknown;
    method?: "GET" | "POST";
    path?: string;
}>): string {
    const proof = {
        v: 1 as const,
        alg: "ed25519-machine-installation-v1" as const,
        machineId: MACHINE_ID,
        installationId: INSTALLATION_ID,
        issuedAt: Date.now(),
        nonce: "publisher-proof-nonce-1",
        method: params.method ?? "POST",
        path: params.path ?? PATH,
        bodySha256Base64Url: createHash("sha256")
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body))
            .digest("base64url"),
        signatureBase64Url: "",
    };
    const signature = tweetnacl.sign.detached(
        createPluginInstallationManifestPublisherSigningInputV1({
            proof: {
                v: proof.v,
                alg: proof.alg,
                machineId: proof.machineId,
                installationId: proof.installationId,
                issuedAt: proof.issuedAt,
                nonce: proof.nonce,
                method: proof.method,
                path: proof.path,
                bodySha256Base64Url: proof.bodySha256Base64Url,
            },
        }),
        params.keyPair.secretKey,
    );
    return Buffer.from(JSON.stringify({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(signature).toString("base64url"),
        },
    }), "utf8").toString("base64url");
}

function trustPublisher(keyPair: tweetnacl.SignKeyPair): void {
    machineFindFirst.mockResolvedValue({
        installationId: INSTALLATION_ID,
        installationPublicKey: new Uint8Array(keyPair.publicKey),
        replacedByMachineId: null,
        revokedAt: null,
    });
}

describe("plugin installation publisher proof", () => {
    beforeEach(() => {
        machineFindFirst.mockReset();
    });

    it("establishes current publisher authority before parsing, then rejects a different canonical body", async () => {
        const body = { caller: "publisher", value: 1 };
        const keyPair = tweetnacl.sign.keyPair();
        trustPublisher(keyPair);

        const preBodyProof = await verifyPluginInstallationPublisherHeaderBeforeBody({
            accountId: ACCOUNT_ID,
            request: {
                method: "POST",
                headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        keyPair,
                        body,
                    }),
                },
            },
            path: PATH,
            required: true,
        });

        expect(preBodyProof).toEqual(expect.objectContaining({
            publisher: {
                machineId: MACHINE_ID,
                installationId: INSTALLATION_ID,
            },
        }));
        expect(machineFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                accountId: ACCOUNT_ID,
                id: MACHINE_ID,
            },
        }));
        if (!preBodyProof) throw new Error("expected a verified publisher proof");

        expect(() => verifyPluginInstallationPublisherBodyBinding({
            proof: preBodyProof,
            body: { caller: "publisher", value: 2 },
        })).toThrow(PluginInstallationPublisherProofError);
        expect(verifyPluginInstallationPublisherBodyBinding({
            proof: preBodyProof,
            body,
        })).toEqual({
            machineId: MACHINE_ID,
            installationId: INSTALLATION_ID,
        });
    });

    it("rejects a signature from a different publisher during the pre-body phase", async () => {
        const trustedKeyPair = tweetnacl.sign.keyPair();
        trustPublisher(trustedKeyPair);

        await expect(verifyPluginInstallationPublisherHeaderBeforeBody({
            accountId: ACCOUNT_ID,
            request: {
                method: "POST",
                headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        keyPair: tweetnacl.sign.keyPair(),
                        body: { value: "does-not-matter-before-body-binding" },
                    }),
                },
            },
            path: PATH,
            required: true,
        })).rejects.toMatchObject({ code: "invalid" });
    });

    it("preserves the one-call verifier for existing consumers by composing the two proof phases", async () => {
        const body = { value: "signed" };
        const keyPair = tweetnacl.sign.keyPair();
        trustPublisher(keyPair);
        const headers = {
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                keyPair,
                body,
            }),
        };

        await expect(verifyPluginInstallationPublisherHeader({
            accountId: ACCOUNT_ID,
            request: { method: "POST", headers, body },
            path: PATH,
            required: true,
        })).resolves.toEqual({
            machineId: MACHINE_ID,
            installationId: INSTALLATION_ID,
        });
        await expect(verifyPluginInstallationPublisherHeader({
            accountId: ACCOUNT_ID,
            request: { method: "POST", headers, body: { value: "tampered" } },
            path: PATH,
            required: true,
        })).rejects.toMatchObject({ code: "invalid" });
    });

    it("verifies an exact bodyless GET publisher proof", async () => {
        const path = "/v3/automations/worker/assignments";
        const keyPair = tweetnacl.sign.keyPair();
        trustPublisher(keyPair);
        const headers = {
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                keyPair,
                body: null,
                method: "GET",
                path,
            }),
        };

        await expect(verifyPluginInstallationPublisherHeader({
            accountId: ACCOUNT_ID,
            request: { method: "GET", headers },
            path,
            required: true,
        })).resolves.toEqual({
            machineId: MACHINE_ID,
            installationId: INSTALLATION_ID,
        });
    });
});
