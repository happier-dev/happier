import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendPushNotificationsAsync = vi.hoisted(() => vi.fn(
    async (messages: ReadonlyArray<{ to: string }>) => messages.map(() => ({ status: "ok" })),
));

vi.mock("expo-server-sdk", () => {
    class Expo {
        static isExpoPushToken(token: unknown): boolean {
            return typeof token === "string" && token.startsWith("ExponentPushToken[");
        }

        chunkPushNotifications(messages: ReadonlyArray<unknown>): ReadonlyArray<ReadonlyArray<unknown>> {
            return [messages];
        }

        async sendPushNotificationsAsync(chunk: ReadonlyArray<{ to: string }>) {
            return await sendPushNotificationsAsync(chunk);
        }

        async getPushNotificationReceiptsAsync() {
            return {};
        }
    }

    return { __esModule: true, Expo };
});

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { refreshTrackedSessionAccountBadgePushes } from "./refreshAccountActivityBadgePushes";

describe("tracked Session badge-refresh push fanout (SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "badge-refresh-fanout-", initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    /**
     * The badge-refresh push is background delivery: it carries no request
     * credential, and its arrival tells the device that this exact Session
     * changed. A follower whose only arm is a restricted Team it has not
     * qualified for must therefore not be a recipient at all — withholding the
     * count alone would still leak the timing.
     */
    it("pushes only to tracked recipients background delivery may currently reach", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const restrictedFollower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const inheritFollower = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const restrictedTeam = await db.team.create({ data: {
            name: `refresh-restricted-${randomUUID()}`,
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "github" }] },
        } });
        const inheritTeam = await db.team.create({ data: { name: `refresh-inherit-${randomUUID()}` } });
        await db.teamMembership.createMany({ data: [
            { teamId: restrictedTeam.id, accountId: restrictedFollower.id, role: "member" as const },
            { teamId: inheritTeam.id, accountId: inheritFollower.id, role: "member" as const },
        ] });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: randomUUID(),
            metadata: "{}",
            encryptionMode: "plain",
            seq: 4,
        } });
        await db.sessionGrant.createMany({ data: ([restrictedTeam, inheritTeam].map(team => ({
            sessionId: session.id, teamId: team.id, accessLevel: "view" as const, effectiveAt: new Date(0),
        }))).map(data => ({ ...data, principalKind: 'team' })) });
        await db.accountSessionFollow.createMany({ data: [restrictedFollower, inheritFollower].map(account => ({
            sessionId: session.id, accountId: account.id, following: true, followPolicy: JSON.stringify({ preset: "important" }),
        })) });
        await db.accountPushToken.createMany({ data: [
            { accountId: owner.id, token: `ExponentPushToken[${owner.id}]` },
            { accountId: restrictedFollower.id, token: `ExponentPushToken[${restrictedFollower.id}]` },
            { accountId: inheritFollower.id, token: `ExponentPushToken[${inheritFollower.id}]` },
        ] });

        await refreshTrackedSessionAccountBadgePushes({ badgeAttentionChanged: true, sessionId: session.id });

        await vi.waitFor(() => { expect(sendPushNotificationsAsync).toHaveBeenCalledTimes(1); }, { timeout: 10_000 });
        const [chunk] = sendPushNotificationsAsync.mock.calls[0]!;
        expect(chunk.map(message => message.to).sort()).toEqual([
            `ExponentPushToken[${inheritFollower.id}]`,
            `ExponentPushToken[${owner.id}]`,
        ].sort());
    });
});
