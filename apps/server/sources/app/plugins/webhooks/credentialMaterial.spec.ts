import { describe, expect, it, vi } from "vitest";

import { createGeneratedPluginWebhookCredentialMaterialV1 } from "./credentialMaterial";

describe("plugin webhook generated credential material", () => {
    it("generates an independent 128-bit version identity and 256-bit GitHub secret", () => {
        const randomBytes = vi.fn((length: number) => {
            if (length === 16) return Uint8Array.from({ length }, (_, index) => index);
            if (length === 32) return Uint8Array.from({ length }, (_, index) => index + 16);
            throw new Error(`unexpected random length ${length}`);
        });

        expect(createGeneratedPluginWebhookCredentialMaterialV1({ randomBytes })).toEqual({
            credentialVersionId: "wh_cred_AAECAwQFBgcICQoLDA0ODw",
            secret: "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8",
        });
        expect(randomBytes.mock.calls).toEqual([[16], [32]]);
    });

    it("rejects a broken random owner instead of weakening generated entropy", () => {
        expect(() => createGeneratedPluginWebhookCredentialMaterialV1({
            randomBytes: () => new Uint8Array(15),
        })).toThrow("exactly 16 bytes");
    });
});
