import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { initEncrypt } from "@/modules/encrypt";
import {
    decryptPluginWebhookCredentialSecretV1,
    encryptPluginWebhookCredentialSecretV1,
    pluginWebhookCredentialEncryptionPathV1,
} from "./credentialCipher";

describe("plugin webhook credential server-at-rest encryption", () => {
    const previous = process.env.HANDY_MASTER_SECRET;

    beforeAll(async () => {
        process.env.HANDY_MASTER_SECRET = "plugin-webhook-credential-test-master-secret";
        await initEncrypt();
    });

    afterAll(() => {
        if (previous === undefined) delete process.env.HANDY_MASTER_SECRET;
        else process.env.HANDY_MASTER_SECRET = previous;
    });

    const identity = {
        routeId: "route_1",
        verifierKind: "github_hmac_sha256_v1" as const,
        credentialVersionId: "credential_1",
    };

    it("purpose-separates server/cluster, route, verifier, version, and schema", () => {
        expect(pluginWebhookCredentialEncryptionPathV1(identity)).toEqual([
            "storage",
            "plugin_webhook_ingress",
            "server_cluster_credential",
            "route_1",
            "github_hmac_sha256_v1",
            "credential_1",
            "v1",
        ]);
    });

    it("round-trips only under the exact credential identity", () => {
        const ciphertext = encryptPluginWebhookCredentialSecretV1({ ...identity, secret: "secret-value" });
        expect(Buffer.from(ciphertext).toString("utf8")).not.toContain("secret-value");
        expect(decryptPluginWebhookCredentialSecretV1({ ...identity, encryptedSecret: ciphertext })).toBe("secret-value");
        expect(() => decryptPluginWebhookCredentialSecretV1({
            ...identity,
            routeId: "route_2",
            encryptedSecret: ciphertext,
        })).toThrow();
    });
});
