import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1 } from "@happier-dev/protocol";
import { registerProjectAccountRowRoutes } from "@/app/api/routes/projects/registerProjectAccountRowRoutes";
import { registerWorkspaceExecutionConfigRoutes } from "@/app/projects/execution/registerWorkspaceExecutionConfigRoutes";
import { readWorkspaceExecutionConfigRow } from "@/app/projects/execution/workspaceExecutionConfigRowService";
import { registerProjectTrustRoutes } from "@/app/projects/trust/registerProjectTrustRoutes";
import { registerAccountDirectoryRoutes } from "@/app/accountDirectory/accountDirectoryRoutes";
import { registerAccountPetLibraryRoutes } from "@/app/pets/accountPetLibraryRoutes";
import { createPrismaAccountPetLibraryPersistence } from "@/app/pets/accountPetLibraryPersistence";
import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";

describe("Account domain read snapshots", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-domain-reads-", sqliteConnectionLimit: 1, initAuth: true,
            env: { HAPPIER_DB_TX_MAX_RETRIES: "0", HAPPIER_DB_TX_MAX_WAIT_MS: "1000", AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" },
        });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    it("serves Project, Workspace, Trust, Directory and pet reads before a blocked primary writer is released", async () => {
        const account = await db.account.create({ data: { id: "domain-snapshot-account", encryptionMode: "plain", firstName: "Snapshot", seq: 1 } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const directoryToken = await auth.createToken(account.id, undefined, { kind: "account_directory", authority: "present_user" });
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerProjectAccountRowRoutes(app);
        registerWorkspaceExecutionConfigRoutes(app);
        registerProjectTrustRoutes(app);
        registerAccountDirectoryRoutes(app);
        registerAccountPetLibraryRoutes(app);
        await app.ready();
        const headers = { authorization: `Bearer ${token}`, "x-happier-account-stored-content-protocol": "4" };
        const address = { serverId: "home", refId: "checkout" };
        const project = { serverId: "home", projectId: "11111111-1111-4111-8111-111111111111" };
        const requests = [
            { method: "POST" as const, url: "/v1/account/project-rows/read", payload: { key: { kind: "relationship-graph" } }, status: 200, body: { status: "absent" } },
            { method: "POST" as const, url: "/v1/account/project-rows/list", payload: {}, status: 200, body: { status: "listed", rows: [], coverage: "complete" } },
            { method: "POST" as const, url: "/v1/projects/execution/config/read", payload: { address }, status: 200, body: { status: "absent" } },
            { method: "GET" as const, url: "/v1/projects/execution/config", status: 200, body: { rows: [] } },
            { method: "POST" as const, url: "/v1/account/project-trust/read", payload: { project }, status: 200, body: { status: "absent" } },
            { method: "POST" as const, url: "/v1/account/project-trust/list", payload: {}, status: 200, body: { rows: [] } },
            { method: "GET" as const, url: ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1, status: 200, body: { accountId: account.id, displayName: "Snapshot" } },
            { method: "GET" as const, url: ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1, status: 200, body: { homes: [], preferredHomeServerIdentityId: null } },
            { method: "GET" as const, url: "/v1/account/pets", status: 200, body: { ok: true, pets: [] } },
            { method: "GET" as const, url: "/v1/account/pets/missing/spritesheet", status: 404, body: { error: "not_found" } },
            { method: "GET" as const, url: "/v1/account/pets/missing/assets/missing", status: 404, body: { error: "not_found" } },
        ];
        const read = async (request: typeof requests[number]) => {
            const requestHeaders = request.url === ACCOUNT_DIRECTORY_ME_HTTP_PATH_V1 || request.url === ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1
                ? { ...headers, authorization: `Bearer ${directoryToken}` }
                : headers;
            return await app.inject({ method: request.method, url: request.url, headers: requestHeaders, ...(request.payload ? { payload: request.payload } : {}) });
        };
        try {
            // Warm real authentication and verify fixtures before introducing contention.
            for (const request of requests) {
                const response = await read(request);
                expect(response.statusCode, `${request.url}: ${response.body}`).toBe(request.status);
                expect(response.json()).toMatchObject(request.body);
            }
            const persistence = createPrismaAccountPetLibraryPersistence();
            const reads: Array<Readonly<{ name: string; read: () => Promise<unknown>; expected: unknown }>> = [
                ...requests.map(request => ({ name: request.url, read: async () => (await read(request)).statusCode, expected: request.status })),
                { name: "Workspace owner read", read: () => readWorkspaceExecutionConfigRow({ accountId: account.id, address }), expected: { status: "absent" } },
                { name: "Pet persistence list", read: () => persistence.listAccountPets(account.id), expected: [] },
                { name: "Pet persistence read", read: () => persistence.readAccountPet(account.id, "missing"), expected: null },
            ];
            const writer = await holdSqliteWriteLock();
            let writeSettled = false;
            const blockedWrite = inTx(tx => tx.account.update({ where: { id: account.id }, data: { seq: 2 } }))
                .then(() => null, (error: unknown) => error).finally(() => { writeSettled = true; });
            const results = new Map<string, unknown>();
            let pending: Promise<void>[] = [];
            try {
                await inTx(tx => tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { id: true } }), { readOnly: true });
                pending = reads.map(async probe => {
                    try { results.set(probe.name, await probe.read()); }
                    catch (error: unknown) { results.set(probe.name, error); }
                });
                // Test-only observation window: the primary writer stays blocked, not a product deadline.
                await vi.waitFor(() => {
                    expect(reads.map(probe => ({ name: probe.name, result: results.get(probe.name) })))
                        .toEqual(reads.map(probe => ({ name: probe.name, result: probe.expected })));
                }, { timeout: 1_000 });
                expect(writeSettled).toBe(false);
            } finally {
                await writer.release();
                await blockedWrite;
                await Promise.all(pending);
            }
        } finally { await app.close(); }
    });
});
