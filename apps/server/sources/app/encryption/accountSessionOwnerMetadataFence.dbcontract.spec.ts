import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import { randomUUID } from "node:crypto";

import {
    db,
    initDbMysql,
    initDbPostgres,
} from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "./accountSessionOwnerMetadataFence";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres"
    ).toString().trim().toLowerCase();
    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const provider = resolveContractProviderFromEnv();
const publicKeyPrefix = "dbcontract-account-session-owner-fence-";

describe("Account Session owner-metadata fence database contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error(
                "Missing DATABASE_URL (required for db contract tests).",
            );
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await db.account.deleteMany({
            where: { publicKey: { startsWith: publicKeyPrefix } },
        });
    });

    afterAll(async () => {
        if (dbConnected) {
            await db.$disconnect();
        }
    });

    it(`serializes concurrent Account fences on ${provider}`, async () => {
        const initialUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        const account = await db.account.create({
            data: {
                publicKey: `${publicKeyPrefix}${randomUUID()}`,
                settingsVersion: 7,
                updatedAt: initialUpdatedAt,
            },
            select: { id: true },
        });
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        let secondAcquired = false;

        const first = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            firstAcquired.resolve();
            await releaseFirst.promise;
        });
        await firstAcquired.promise;

        const second = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id);
            secondAcquired = true;
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(secondAcquired).toBe(false);
        } finally {
            releaseFirst.resolve();
        }

        await first;
        await second;
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: {
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            settingsVersion: 7,
            updatedAt: initialUpdatedAt,
        });
    });
});
