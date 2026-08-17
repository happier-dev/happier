import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import { applyLightAuthTestEnv } from "@/testkit/applyLightAuthTestEnv";
import { auth } from "./auth";

describe("auth (oauth state tokens)", () => {
    const envBackup = snapshotEnv();
    const requestDigest = `aemrb1_${"A".repeat(43)}`;

    beforeAll(async () => {
        await applyLightAuthTestEnv();
        await auth.init();
    });

    afterAll(() => {
        restoreEnv(envBackup);
    });

    it("exposes createOauthStateToken + verifyOauthStateToken helpers", () => {
        expect(typeof (auth as any).createOauthStateToken).toBe("function");
        expect(typeof (auth as any).verifyOauthStateToken).toBe("function");
    });

    it("round-trips oauth state tokens for auth + connect flows", async () => {
        const token = await (auth as any).createOauthStateToken({
            flow: "connect",
            provider: "github",
            sid: "sid_1",
            userId: "u1",
        });

        const verified = await (auth as any).verifyOauthStateToken(token);
        expect(verified).toEqual({
            flow: "connect",
            provider: "github",
            sid: "sid_1",
            userId: "u1",
            publicKey: null,
            proofHash: null,
        });

        const authToken = await (auth as any).createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid_2",
            publicKey: "pk_hex_1",
        });
        const verifiedAuth = await (auth as any).verifyOauthStateToken(authToken);
        expect(verifiedAuth).toEqual({
            flow: "auth",
            provider: "github",
            sid: "sid_2",
            userId: null,
            publicKey: "pk_hex_1",
            proofHash: null,
        });
    });

    it("round-trips keyless oauth state tokens with a proof hash", async () => {
        const token = await (auth as any).createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid_keyless_1",
            publicKey: null,
            proofHash: "sha256hex_1",
        });

        const verified = await (auth as any).verifyOauthStateToken(token);
        expect(verified).toEqual({
            flow: "auth",
            provider: "github",
            sid: "sid_keyless_1",
            userId: null,
            publicKey: null,
            proofHash: "sha256hex_1",
        });
    });

    it("round-trips a first-key migration step-up binding through the existing auth state token", async () => {
        const token = await (auth as any).createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid_step_up_1",
            userId: "account_1",
            proofHash: "a".repeat(64),
            purpose: "account_encryption_first_key",
            requestDigest,
        });

        await expect((auth as any).verifyOauthStateToken(token)).resolves.toEqual({
            flow: "auth",
            provider: "github",
            sid: "sid_step_up_1",
            userId: "account_1",
            publicKey: null,
            proofHash: "a".repeat(64),
            purpose: "account_encryption_first_key",
            requestDigest,
        });
    });

    it("preserves a V5 transition-bound first-key step-up digest through OAuth state", async () => {
        const transitionDigest = `aemtb1_${"A".repeat(43)}`;
        const token = await (auth as any).createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid_transition_step_up_1",
            userId: "account_1",
            proofHash: "a".repeat(64),
            purpose: "account_encryption_first_key",
            requestDigest: transitionDigest,
        });

        await expect((auth as any).verifyOauthStateToken(token)).resolves.toMatchObject({
            purpose: "account_encryption_first_key",
            requestDigest: transitionDigest,
        });
    });

    it("rejects a first-key state that is not bound to a canonical migration digest", async () => {
        await expect((auth as any).createOauthStateToken({
            flow: "auth",
            provider: "github",
            sid: "sid_step_up_invalid",
            userId: "account_1",
            proofHash: "a".repeat(64),
            purpose: "account_encryption_first_key",
            requestDigest: "not-a-canonical-digest",
        })).rejects.toThrow(/step-up binding/i);
    });

    it("rejects creating oauth state tokens with an empty provider", async () => {
        await expect(
            (auth as any).createOauthStateToken({
                flow: "connect",
                provider: "   ",
                userId: "u1",
            })
        ).rejects.toThrow(/provider/i);
    });

    it("rejects creating oauth state tokens with an invalid flow", async () => {
        await expect(
            (auth as any).createOauthStateToken({
                flow: "nope",
                provider: "github",
                userId: "u1",
            })
        ).rejects.toThrow(/flow/i);
    });
});
