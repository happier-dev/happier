import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { enforceLoginEligibility } from "@/app/auth/enforceLoginEligibility";
import { readSignInPolicyGeneration } from "@/app/auth/signInPolicyGeneration";
import { eventRouter } from "@/app/events/eventRouter";
import { readHomeConfigEnv, setHomeSettings } from "@/app/home/settings/homeSettings";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { recheckSocketAdmittedUnderOlderSignInPolicy, registerSignInPolicyEviction } from "./signInPolicyEviction";

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

    // A decision that read the old policy before the change, and finished after it, must not
    // cache a "yes" under the new policy; a socket admitted by such a decision reaches the
    // connected set only after the eviction pass enumerated it, so it is re-decided on connection.
    it("discards an eligibility result decided under an older policy and re-checks the socket it admitted", async () => {
        const owner = await connectedAccount("owner");
        sequence += 1;
        const late = await db.account.create({ data: { publicKey: `policy-eviction-${sequence}`, homeRole: "member" }, select: { id: true } });
        const control = { connected: true, data: { userId: owner.accountId, signInPolicyGeneration: -1 },
            disconnect(_close?: boolean) { control.connected = false; } };
        eventRouter.clearIo();
        const release = registerSignInPolicyEviction({ sockets: () => [], onSignInPolicyChange: listener => eventRouter.onSignInPolicyChange(listener) });
        try {
            // The handshake's decision reads the current (open) policy, then stalls.
            const admittedGeneration = readSignInPolicyGeneration();
            let resume!: () => void;
            const stalled = new Promise<void>(resolve => { resume = resolve; });
            let policyRead!: () => void;
            const read = new Promise<void>(resolve => { policyRead = resolve; });
            const decision = enforceLoginEligibility({ accountId: late.id, readEnv: async () => {
                const env = await readHomeConfigEnv();
                policyRead();
                await stalled;
                return env;
            } });
            await read;
            expect((await setHomeSettings({ actorAccountId: owner.accountId,
                write: { expectedRevision: 0, values: { AUTH_REQUIRED_LOGIN_PROVIDERS: ["github"] } } })).status).toBe("applied");
            await vi.waitFor(() => { if (readSignInPolicyGeneration() === admittedGeneration) throw new Error("No policy change yet"); },
                { timeout: 5_000, interval: 20 });
            resume();
            // The stalled decision still answers its own (pre-change) caller...
            expect(await decision).toEqual({ ok: true });
            // ...but caches nothing: the next decision applies the new policy despite the 60 s cache.
            expect(await enforceLoginEligibility({ accountId: late.id, readEnv: () => readHomeConfigEnv() }))
                .toMatchObject({ ok: false, error: "provider-required" });

            // The socket that decision admitted connects now, and is re-decided once.
            const socket = { connected: true, data: { userId: late.id, signInPolicyGeneration: admittedGeneration },
                disconnect(_close?: boolean) { socket.connected = false; } };
            await recheckSocketAdmittedUnderOlderSignInPolicy(socket);
            expect(socket.connected).toBe(false);
            // Control: a socket admitted under the current generation is not re-decided.
            control.data.signInPolicyGeneration = readSignInPolicyGeneration();
            await recheckSocketAdmittedUnderOlderSignInPolicy(control);
            expect(control.connected).toBe(true);
        } finally { release(); }
    });
});
