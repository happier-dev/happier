import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { startSocket } from "./socket";
import type { Fastify as AppFastify } from "./types";
import { auth } from "@/app/auth/auth";
import { initDbSqlite, db } from "@/storage/db";
import { applyLightDefaultEnv, ensureHandyMasterSecret } from "@/flavors/light/env";
import { initEncrypt } from "@/modules/encrypt";
import { createEnvPatcher } from "./socket.env.testHelper";

function runServerPrismaMigrateDeploySqlite(params: { cwd: string; env: NodeJS.ProcessEnv }): void {
    const res = spawnSync(
        "yarn",
        ["-s", "prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
        {
            cwd: params.cwd,
            env: { ...(params.env as Record<string, string>), RUST_LOG: "info" },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    if (res.status !== 0) {
        const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
        throw new Error(`prisma migrate deploy failed (status=${res.status}). ${out}`);
    }
}

type ProviderRequiredErrorPayload = {
    message: string;
    data: {
        error: string;
        provider?: string;
        statusCode?: number;
    } | null;
};

function parseConnectErrorPayload(err: unknown): ProviderRequiredErrorPayload {
    const obj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const dataObj = typeof obj.data === "object" && obj.data !== null ? (obj.data as Record<string, unknown>) : null;
    return {
        message: typeof obj.message === "string" ? obj.message : String(err),
        data: dataObj
            ? {
                error: typeof dataObj.error === "string" ? dataObj.error : "unknown",
                provider: typeof dataObj.provider === "string" ? dataObj.provider : undefined,
                statusCode: typeof dataObj.statusCode === "number" ? dataObj.statusCode : undefined,
            }
            : null,
    };
}

async function waitForConnectionFailure(socket: ReturnType<typeof ioClient>): Promise<ProviderRequiredErrorPayload> {
    return await new Promise<ProviderRequiredErrorPayload>((resolve, reject) => {
        const cleanup = () => {
            socket.off("connect_error", onConnectError);
            socket.off("connect", onConnect);
        };

        const onConnectError = (err: unknown) => {
            cleanup();
            resolve(parseConnectErrorPayload(err));
        };

        const onConnect = () => {
            cleanup();
            reject(new Error("Socket connected unexpectedly - policy enforcement failed"));
        };

        socket.on("connect_error", onConnectError);
        socket.on("connect", onConnect);
    });
}

describe("startSocket (auth policy enforcement)", () => {
    const env = createEnvPatcher([
        "HAPPIER_DB_PROVIDER",
        "HAPPY_DB_PROVIDER",
        "DATABASE_URL",
        "HAPPY_SERVER_LIGHT_DATA_DIR",
        "HAPPIER_SERVER_LIGHT_DATA_DIR",
        "HAPPY_SERVER_LIGHT_FILES_DIR",
        "HAPPIER_SERVER_LIGHT_FILES_DIR",
        "HAPPY_SERVER_LIGHT_DB_DIR",
        "HAPPIER_SERVER_LIGHT_DB_DIR",
        "PUBLIC_URL",
        "HANDY_MASTER_SECRET",
        "AUTH_REQUIRED_LOGIN_PROVIDERS",
    ]);
    let baseDir: string;

    beforeAll(async () => {
        baseDir = await mkdtemp(join(tmpdir(), "happier-socket-policy-"));
        const dbPath = join(baseDir, "test.sqlite");

        env.setMany({
            HAPPIER_DB_PROVIDER: "sqlite",
            HAPPY_DB_PROVIDER: "sqlite",
            DATABASE_URL: `file:${dbPath}`,
            HAPPY_SERVER_LIGHT_DATA_DIR: baseDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir,
        });
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        await initEncrypt();
        await auth.init();

        runServerPrismaMigrateDeploySqlite({ cwd: process.cwd(), env: process.env });
        await initDbSqlite();
        await db.$connect();
    }, 120_000);

    afterAll(async () => {
        await db.$disconnect();
        env.restore();
        await rm(baseDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        vi.unstubAllGlobals();
        env.set("AUTH_REQUIRED_LOGIN_PROVIDERS", undefined);
    });

    afterEach(async () => {
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    it("disconnects a user-scoped socket when GitHub is required but the account has no GitHub identity", async () => {
        env.set("AUTH_REQUIRED_LOGIN_PROVIDERS", "github");

        const account = await db.account.create({
            data: { publicKey: `pk-${Date.now()}` },
            select: { id: true },
        });
        const token = await auth.createToken(account.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: { token },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("provider-required");
        expect(payload.data).toEqual({
            error: "provider-required",
            provider: "github",
            statusCode: 403,
        });
    }, 30_000);

    it("disconnects a machine-scoped socket when the machine belongs to another account", async () => {
        const owningAccount = await db.account.create({
            data: { publicKey: `pk-owning-${Date.now()}` },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { publicKey: `pk-other-${Date.now()}` },
            select: { id: true },
        });

        await db.machine.create({
            data: {
                id: "m-test",
                accountId: owningAccount.id,
                metadata: "metadata",
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                active: false,
            },
            select: { id: true },
        });

        const token = await auth.createToken(otherAccount.id);

        const app = Fastify({ logger: false }) as unknown as AppFastify;
        startSocket(app);
        await app.listen({ port: 0, host: "127.0.0.1" });
        const address = app.server.address();
        const port = typeof address === "object" && address ? address.port : null;
        if (!port) {
            await app.close();
            throw new Error("Failed to bind socket server");
        }

        const socket = ioClient(`http://127.0.0.1:${port}`, {
            path: "/v1/updates",
            transports: ["websocket"],
            reconnection: false,
            auth: { token, clientType: "machine-scoped", machineId: "m-test" },
        });

        let payload: ProviderRequiredErrorPayload;
        try {
            payload = await waitForConnectionFailure(socket);
        } finally {
            socket.close();
            await app.close();
        }

        expect(payload.message).toBe("invalid-machine");
        expect(payload.data).toEqual({
            error: "invalid-machine",
            provider: undefined,
            statusCode: 403,
        });
    }, 30_000);
});
