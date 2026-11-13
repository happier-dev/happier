import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    createFakeRouteApp,
    createReplyStub,
    getRouteHandler,
} from "../../testkit/routeHarness";
import { evaluateAccountStoredContentCompatibility } from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { inTxPostgresControlStatementMock } from "../../testkit/dbMocks";
import { homeConfigSnapshotPostgresQueryMock } from "@/app/home/settings/homeConfigSnapshot.testkit";

const state = vi.hoisted(() => ({
    tx: undefined as ReturnType<typeof createTx> | undefined,
}));

function currentTx() {
    if (!state.tx) throw new Error("Settings transaction fixture is not initialized");
    return state.tx;
}

vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock } = await import("../../testkit/dbMocks");
    return { db: createDbTransactionMock(currentTx).wrapDb({
        $queryRawUnsafe: (query: string, ...values: unknown[]) => currentTx().$queryRawUnsafe(query, ...values),
    }) };
});

import { registerAccountSettingsHistoryRoutes } from "./registerAccountSettingsHistoryRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";

function createTx() {
    const account = {
        seq: 7,
        encryptionMode: "plain" as const,
        publicKey: null,
        contentPublicKey: null,
        contentPublicKeySig: null,
        settings: null,
        settingsVersion: 1,
    };
    return {
        ...inTxPostgresControlStatementMock,
        $executeRawUnsafe: vi.fn(inTxPostgresControlStatementMock.$executeRawUnsafe),
        $queryRawUnsafe: vi.fn(async (query: string, ...values: unknown[]) => {
            if (query.includes('FROM (SELECT 1) AS singleton')) {
                return homeConfigSnapshotPostgresQueryMock.$queryRawUnsafe.call({
                    homeSettings: { findUnique: async () => null },
                    homeGovernancePolicy: { findUnique: async () => null },
                }, query, values[0]);
            }
            if (query.startsWith('SELECT "id" FROM "Account"')) return [{ id: "account-1" }];
            throw new Error("Unexpected Settings fixture SQL");
        }),
        account: {
            findUnique: vi.fn(async (_input: Readonly<{
                select?: Readonly<{ settings?: boolean }>;
            }>) => account),
            updateMany: vi.fn(async () => ({ count: 0 })),
        },
        accountSettingsSnapshot: {
            findUnique: vi.fn(async () => ({
                accountId: "account-1",
                version: 3,
                settingsDbValue: null,
                encryptionMode: "plain" as const,
            })),
        },
        userKVStore: { findUnique: vi.fn(async () => null) },
    };
}

function admissionCallOrder(tx: ReturnType<typeof createTx>): number {
    const calls = tx.$queryRawUnsafe.mock.calls.flatMap(([query], index) =>
        query.startsWith('SELECT "id" FROM "Account"') ? [tx.$queryRawUnsafe.mock.invocationCallOrder[index]!] : []);
    expect(calls).toHaveLength(1);
    return calls[0]!;
}

function settingsPayloadReadOrder(tx: ReturnType<typeof createTx>): number {
    const index = tx.account.findUnique.mock.calls.findIndex(
        ([input]) => input?.select?.settings === true,
    );
    expect(index).toBeGreaterThanOrEqual(0);
    return tx.account.findUnique.mock.invocationCallOrder[index]!;
}

function storedContentCompatibility(protocolVersion: number | null) {
    return evaluateAccountStoredContentCompatibility(
        protocolVersion === null
            ? { status: "missing" }
            : {
                status: "valid",
                declaration: { v: 1, protocolVersion },
            },
    );
}

describe("Account Settings writer admission", () => {
    beforeEach(() => {
        state.tx = createTx();
    });

    it("admits the legacy Settings writer before it reads the current Settings payload", async () => {
        const app = createFakeRouteApp();
        registerAccountSettingsRoutes(app as any);
        const write = getRouteHandler(app, "POST", "/v1/account/settings");
        const reply = createReplyStub();

        await write({
            userId: "account-1",
            // Use the ordinary Account credential provenance both writers admit.
            authAuthority: "present_user",
            authTokenKind: "account",
            accountStoredContentCompatibility: storedContentCompatibility(4),
            body: { settings: "ciphertext", expectedVersion: 0 },
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(admissionCallOrder(currentTx())).toBeLessThan(
            settingsPayloadReadOrder(currentTx()),
        );
    });

    it("admits the envelope Settings writer before it reads the current Settings payload", async () => {
        const app = createFakeRouteApp();
        registerAccountSettingsRoutes(app as any);
        const write = getRouteHandler(app, "POST", "/v2/account/settings");
        const reply = createReplyStub();

        await write({
            userId: "account-1",
            authAuthority: "present_user",
            authTokenKind: "account",
            accountStoredContentCompatibility: storedContentCompatibility(4),
            body: { content: null, expectedVersion: 0 },
        }, reply);

        expect(reply.statusCode).toBe(200);
        expect(admissionCallOrder(currentTx())).toBeLessThan(
            settingsPayloadReadOrder(currentTx()),
        );
    });

    it.each([
        {
            label: "the released 0.2 writer without a declaration",
            protocolVersion: null,
        },
        {
            label: "a V3 writer without profile-preserving semantics",
            protocolVersion: 3,
        },
    ])("rejects $label before either Settings write route opens a transaction", async ({ protocolVersion }) => {
        for (const route of [
            {
                path: "/v1/account/settings",
                body: { settings: "ciphertext", expectedVersion: 0 },
            },
            {
                path: "/v2/account/settings",
                body: { content: null, expectedVersion: 0 },
            },
        ]) {
            state.tx = createTx();
            const app = createFakeRouteApp();
            registerAccountSettingsRoutes(app as any);
            const write = getRouteHandler(app, "POST", route.path);
            const reply = createReplyStub();

            await write({
                userId: "account-1",
                authAuthority: "present_user",
                authTokenKind: "account",
                accountStoredContentCompatibility:
                    storedContentCompatibility(protocolVersion),
                body: route.body,
            }, reply);

            expect(reply.statusCode, route.path).toBe(426);
            expect(reply.send, route.path).toHaveBeenCalledWith({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 4,
                },
            });
            expect(state.tx.$queryRawUnsafe.mock.calls.some(([query]) => query.includes('FROM "Account"')), route.path).toBe(false);
            expect(state.tx.account.findUnique, route.path).not.toHaveBeenCalled();
            expect(state.tx.account.updateMany, route.path).not.toHaveBeenCalled();
        }
    });

    it("rejects the retired Settings-history restore before it opens the selected snapshot", async () => {
        const app = createFakeRouteApp();
        registerAccountSettingsHistoryRoutes(app as any);
        const restore = getRouteHandler(
            app,
            "POST",
            "/v2/account/settings/history/:version/restore",
        );
        const reply = createReplyStub();

        await restore({
            userId: "account-1",
            params: { version: 3 },
            body: { content: null, expectedVersion: 0 },
        }, reply);

        expect(reply.statusCode).toBe(426);
        expect(currentTx().$executeRawUnsafe).not.toHaveBeenCalled();
        expect(currentTx().$queryRawUnsafe).not.toHaveBeenCalled();
        expect(currentTx().accountSettingsSnapshot.findUnique).not.toHaveBeenCalled();
    });
});
