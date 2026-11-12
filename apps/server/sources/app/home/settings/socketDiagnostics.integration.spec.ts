import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setHomeSettings } from "./homeSettings";
import { refreshAuthDiagnosticsLogsFlag } from "./authDiagnosticsFlag";

const logging = vi.hoisted(() => ({ debug: vi.fn(), log: vi.fn<(meta: Record<string, unknown>, message?: string) => void>() }));
const settingsReads = () => logging.log.mock.calls.filter(([meta]) => meta.phase === "db.HomeSettings.findUnique");
// Logging output and the socket are IO boundaries; all Home and transcript logic stays real.
vi.mock("@/utils/logging/log", async importOriginal => ({
    ...await importOriginal<typeof import("@/utils/logging/log")>(), ...logging,
}));

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-socket-diagnostics-", initEncrypt: true,
        env: { HAPPIER_WEB_LATENCY_TRACE: "1" } });
    vi.spyOn((await import("@/utils/logging/log")).logger, "isLevelEnabled").mockReturnValue(true);
    delete process.env.HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
    delete process.env.HAPPY_SOCKET_MESSAGE_DIAGNOSTIC_LOGS;
    await refreshAuthDiagnosticsLogsFlag();
    expect(settingsReads()).toHaveLength(1);
    logging.log.mockClear();
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await harness?.close(); });

describe("transcript diagnostics Home read cost", () => {
    it("reads no settings for 100 messages and applies each committed flag change to the next message", async () => {
        const owner = await db.account.create({ data: { homeRole: "owner", status: "active" } });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(owner.id, socket as unknown as Socket, {
            connectionType: "user-scoped", userId: owner.id, socket: socket as unknown as Socket,
        });
        const message = getSocketHandler(socket, "message");
        const acks: unknown[] = [];
        const send = () => message({ sid: "missing-diagnostics-session", message: { t: "plain", v: { text: "fixture" } } },
            (ack: unknown) => acks.push(ack));
        logging.debug.mockClear();
        for (let i = 0; i < 100; i++) await send();
        expect(acks).toHaveLength(100);
        expect(settingsReads()).toHaveLength(0);
        expect(logging.debug).not.toHaveBeenCalled();

        expect((await setHomeSettings({ actorAccountId: owner.id,
            write: { expectedRevision: 0, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: true } } })).status).toBe("applied");
        logging.log.mockClear();
        logging.debug.mockClear();
        await send();
        expect(logging.debug).toHaveBeenCalledTimes(1);
        expect(settingsReads()).toHaveLength(0);

        expect((await setHomeSettings({ actorAccountId: owner.id,
            write: { expectedRevision: 1, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: false } } })).status).toBe("applied");
        logging.log.mockClear();
        logging.debug.mockClear();
        await send();
        expect(logging.debug).not.toHaveBeenCalled();
        expect(settingsReads()).toHaveLength(0);
    });
});
