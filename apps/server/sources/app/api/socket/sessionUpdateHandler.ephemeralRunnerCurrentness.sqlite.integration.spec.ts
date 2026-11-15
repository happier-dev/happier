import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createMaterializedEphemeralRunnerFixture } from "@/app/ephemeralRunner/materializedRunner.testkit";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, getSocketHandler } from "../testkit/socketHarness";
import { sessionUpdateHandler } from "./sessionUpdateHandler";
import { usageHandler } from "./usageHandler";

describe("ephemeral Runner legacy socket authority on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-runner-socket-currentness-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
            env: {
                HANDY_MASTER_SECRET: "runner-socket-currentness-secret",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.sessionMessage.deleteMany(),
            () => db.accessKey.deleteMany(),
            () => db.ephemeralRunnerActivation.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => await harness.close());

    async function createRegisteredRunner() {
        const fixture = await createMaterializedEphemeralRunnerFixture({
            sessionActive: false,
            sessionLastActiveAt: new Date("2026-09-14T07:00:00.000Z"),
        });
        await db.session.update({
            where: { id: fixture.sessionId },
            data: {
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                metadata: "{}",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
        });
        const verified = await import("@/app/auth/auth").then(({ auth }) => auth.verifyToken(fixture.token));
        const principal = verified?.ephemeralSessionRunnerPrincipal;
        if (!principal) throw new Error("expected verified Runner principal");

        const socket = createFakeSocket({
            id: `runner-socket-${randomUUID()}`,
            data: {
                clientType: "session-scoped",
                sessionScopedBinding: {
                    sessionId: fixture.sessionId,
                    machineId: fixture.machineId,
                    proof: "machine-access-key",
                },
            },
        });
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({
            socket,
            binding: {
                accountId: fixture.accountId,
                machineId: fixture.machineId,
                sessionId: fixture.sessionId,
            },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");

        const connection = {
            connectionType: "session-scoped" as const,
            socket,
            userId: fixture.accountId,
            sessionId: fixture.sessionId,
        };
        const trustedPublisher = {
            presence,
            binding: {
                accountId: fixture.accountId,
                machineId: fixture.machineId,
                sessionId: fixture.sessionId,
            },
        };
        const admission = {
            principalKind: "ephemeral-session-runner" as const,
            principal,
        };
        sessionUpdateHandler(
            fixture.accountId,
            socket as never,
            connection as never,
            trustedPublisher,
            admission,
        );
        return { fixture, principal, socket, connection, admission };
    }

    it("accepts Agent state from the exact current Runner publisher", async () => {
        const { fixture, socket } = await createRegisteredRunner();
        const callback = vi.fn();

        await getSocketHandler(socket, "update-state")({
            sid: fixture.sessionId,
            agentState: "current-runner-state",
            expectedVersion: 0,
        }, callback);

        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            result: "success",
            version: 1,
        }));
        await expect(db.session.findUniqueOrThrow({
            where: { id: fixture.sessionId },
            select: { agentState: true, agentStateVersion: true },
        })).resolves.toEqual({ agentState: "current-runner-state", agentStateVersion: 1 });
    });

    it.each([
        {
            boundary: "activation terminalization",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.ephemeralRunnerActivation.update({
                    where: { id: fixture.activationId },
                    data: { state: "closed", closeReason: "revoked" },
                });
            },
        },
        {
            boundary: "AccessKey deletion",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.accessKey.delete({
                    where: {
                        accountId_machineId_sessionId: {
                            accountId: fixture.accountId,
                            machineId: fixture.machineId,
                            sessionId: fixture.sessionId,
                        },
                    },
                });
            },
        },
        {
            boundary: "Machine revocation",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: { active: false, revokedAt: new Date() },
                });
            },
        },
        {
            boundary: "Machine installation replacement",
            revoke: async (fixture: Awaited<ReturnType<typeof createMaterializedEphemeralRunnerFixture>>) => {
                await db.machine.update({
                    where: { id: fixture.machineId },
                    data: {
                        installationId: `replacement-${randomUUID()}`,
                        installationPublicKey: new Uint8Array(32).fill(29),
                    },
                });
            },
        },
    ])("rejects Agent state after $boundary without mutating the Session", async ({ revoke }) => {
        const { fixture, socket } = await createRegisteredRunner();
        await revoke(fixture);
        const callback = vi.fn();

        await getSocketHandler(socket, "update-state")({
            sid: fixture.sessionId,
            agentState: "stale-runner-state",
            expectedVersion: 0,
        }, callback);

        expect(callback).toHaveBeenCalledWith({ result: "forbidden" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: fixture.sessionId },
            select: { agentState: true, agentStateVersion: true },
        })).resolves.toEqual({ agentState: null, agentStateVersion: 0 });
    });

    it("rejects the legacy message event for a current Runner and leaves transcript writing to the fenced observation event", async () => {
        const { fixture, socket } = await createRegisteredRunner();
        const callback = vi.fn();

        await getSocketHandler(socket, "message")({
            sid: fixture.sessionId,
            localId: `legacy-runner-${randomUUID()}`,
            message: {
                t: "plain",
                v: { role: "assistant", content: { type: "text", text: "legacy-runner-message" } },
            },
            messageRole: "agent",
        }, callback);

        expect(callback).toHaveBeenCalledWith({ ok: false, error: "forbidden" });
        await expect(db.sessionMessage.count({ where: { sessionId: fixture.sessionId } })).resolves.toBe(0);
    });

    it("admits Runner usage events only for its own Session while its materialized principal is current", async () => {
        const { fixture, principal, socket, connection } = await createRegisteredRunner();
        usageHandler(fixture.accountId, socket as never, connection as never, principal);
        const emitUsage = async (sessionId: string, externalKey: string) => {
            const callback = vi.fn();
            await getSocketHandler(socket, "usage-event")({
                sessionId, machineId: fixture.machineId, observedAt: 1_000, agentId: "codex", source: "runtime",
                scope: "turn_delta", isCumulative: false, externalKey,
                tokens: { input: 7, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 7 },
                cost: { reportedUsd: 0.01, estimatedUsd: 0, currency: "USD" },
            }, callback);
            return callback.mock.calls[0]?.[0];
        };

        await expect(emitUsage(fixture.sessionId, "runner-own")).resolves.toMatchObject({ success: true });
        await expect(emitUsage(`other-${randomUUID()}`, "runner-other")).resolves.toEqual({ success: false, error: "Forbidden" });
        await expect(db.usageEvent.count()).resolves.toBe(1);

        await db.ephemeralRunnerActivation.update({
            where: { id: fixture.activationId },
            data: { state: "closed", closeReason: "revoked" },
        });
        await expect(emitUsage(fixture.sessionId, "runner-revoked")).resolves.toEqual({ success: false, error: "Forbidden" });
        await expect(db.usageEvent.count()).resolves.toBe(1);
    });
});
