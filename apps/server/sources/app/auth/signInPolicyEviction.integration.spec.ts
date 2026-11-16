import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { eventRouter } from "@/app/events/eventRouter";
import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { registerSignInPolicyEviction } from "./signInPolicyEviction";

// Every other single-credential revocation (token revoke, sign-out everywhere, Account lifecycle,
// Machine revoke) withdraws live sockets. A Home sign-in policy change must too: the handshake is
// the only place a socket's sign-in eligibility is decided, so a narrowed policy re-decides it for
// the connected Accounts and disconnects the ones it now refuses.
describe("Home sign-in policy change and live sockets", () => {
    let harness: LightSqliteHarness;
    let sequence = 0;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-sign-in-policy-eviction-", initAuth: true,
            initEncrypt: true, initFiles: false,
            // A long positive TTL: the change must not wait for a cached eligibility result to expire.
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: "", AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "60000" } });
    }, 120_000);
    afterAll(async () => { await harness.close(); });
    afterEach(async () => { await db.homeSettings.deleteMany({}); });

    async function connectedAccount(homeRole: "owner" | "member") {
        sequence += 1;
        const account = await db.account.create({ data: { publicKey: `policy-eviction-${sequence}`, homeRole }, select: { id: true } });
        const socket = { id: `socket-${sequence}`, connected: true, data: { userId: account.id },
            disconnect(_close?: boolean) { socket.connected = false; } };
        // The handshake admitted it, warming the positive eligibility cache.
        expect(await enforceLoginEligibility({ accountId: account.id, readEnv: () => readHomeConfigEnv() })).toEqual({ ok: true });
        return { accountId: account.id, socket };
    }

    it("disconnects connected Accounts the narrowed sign-in policy refuses, and only on a policy change", async () => {
        const owner = await connectedAccount("owner");
        const member = await connectedAccount("member");
        const sockets = [owner.socket, member.socket];
        eventRouter.clearIo();
        const release = registerSignInPolicyEviction({ sockets: () => sockets.filter(socket => socket.connected),
            onSignInPolicyChange: listener => eventRouter.onSignInPolicyChange(listener) });
        try {
            // Control: a non-policy Home setting leaves every socket connected.
            expect((await setHomeSettings({ actorAccountId: owner.accountId,
                write: { expectedRevision: 0, values: { HAPPIER_HOME_DISPLAY_NAME: "Studio" } } })).status).toBe("applied");
            await new Promise(resolve => setTimeout(resolve, 50));
            expect(sockets.map(socket => socket.connected)).toEqual([true, true]);

            // Neither Account has GitHub linked, so the policy now refuses both of them.
            expect((await setHomeSettings({ actorAccountId: owner.accountId,
                write: { expectedRevision: 1, values: { AUTH_REQUIRED_LOGIN_PROVIDERS: ["github"] } } })).status).toBe("applied");
            await vi.waitFor(() => { if (sockets.some(socket => socket.connected)) throw new Error("Sockets still connected"); },
                { timeout: 5_000, interval: 20 });
            // The same policy refuses a new admission (the handshake and HTTP owner), without waiting for the cache.
            expect(await enforceLoginEligibility({ accountId: member.accountId, readEnv: () => readHomeConfigEnv() }))
                .toMatchObject({ ok: false, error: "provider-required" });
        } finally { release(); }
    });
});
