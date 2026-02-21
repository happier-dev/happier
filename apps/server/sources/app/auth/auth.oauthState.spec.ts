import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { restoreEnv, snapshotEnv } from "@/app/api/testkit/env";
import { auth } from "./auth";

describe("auth (oauth state tokens)", () => {
    const envBackup = snapshotEnv();

    beforeAll(async () => {
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
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
