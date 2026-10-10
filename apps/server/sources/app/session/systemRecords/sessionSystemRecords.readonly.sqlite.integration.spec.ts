import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { registerSessionSystemRecordRoutes } from "@/app/api/routes/session/registerSessionSystemRecordRoutes";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { holdSqliteWriteLock } from "@/testkit/sqliteWriteLock";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "./sessionSystemRecordProtocolContract";
import {
    listSessionSystemRecordsV1,
    readSessionSystemRecordV1,
    upsertSessionSystemRecordV1,
    writePermissionMediationRecord,
} from "./sessionSystemRecordService";

describe("Session SystemRecords read snapshots on SQLite", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-system-record-read-snapshot-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            env: {
                HAPPIER_DB_TX_MAX_RETRIES: "0",
                HAPPIER_DB_TX_MAX_WAIT_MS: "1000",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
                HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: "1",
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
            },
        });
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);
    }, 120_000);

    afterAll(async () => {
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        await harness?.close();
    });

    it("finishes authenticated host, permission and plugin reads before a blocked primary writer is released", async () => {
        const account = await db.account.create({ data: {
            ...createSignedAccountContentBinding(), encryptionMode: "plain", seq: 1,
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: "system-record-read-snapshot", encryptionMode: "plain", metadata: "{}",
        } });
        const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
        const authentication = createPresentUserSessionAccessAuthentication();
        const baseParams = { actorUserId: account.id, sessionId: session.id, authentication };
        const address = { owner: "host" as const, namespace: "memory", kind: "synopsis.v1", localId: "synopsis" };
        const content = { t: "plain" as const, v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: "committed" } };
        const host = await upsertSessionSystemRecordV1({ ...baseParams, address, content, expectedRevision: null });
        expect(host.ok).toBe(true);
        const identity = { sessionId: session.id, turnId: "turn", requestId: "request" };
        expect((await writePermissionMediationRecord({ ...baseParams, identity,
            request: { kind: "remote_settlement.v1", content: { t: "plain", v: { outcome: "committed" } }, expectedRevision: null },
        })).ok).toBe(true);
        const pluginParams = { ...baseParams, pluginId: "acme.notes" };
        const pluginAddress = { owner: "plugin" as const, namespace: "notes", kind: "entry.v1", localId: "note" };
        expect((await upsertSessionSystemRecordV1({ ...pluginParams, address: pluginAddress,
            content: { t: "plain", v: { title: "committed" } }, expectedRevision: null,
        })).ok).toBe(true);

        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        registerSessionSystemRecordRoutes(app);
        await app.ready();
        const base = `/v2/sessions/${session.id}`;
        const headers = { authorization: `Bearer ${token}`, "x-happier-account-stored-content-protocol": "4" };
        const strictHeaders = { ...headers, "x-happier-session-system-records-protocol": "1" };
        const reads = [
            { url: `${base}/system-records`, query: { namespace: "memory" }, headers },
            { url: `${base}/system-records/record`, query: { namespace: "memory", localId: "synopsis" }, headers },
            { url: `${base}/system-records/latest`, query: { namespace: "memory", kind: "synopsis.v1" }, headers },
            { url: `${base}/system-records`, query: { owner: "host", namespace: "memory" }, headers: strictHeaders },
            { url: `${base}/system-records/record`, query: address, headers: strictHeaders },
            { url: `${base}/system-records`, query: { owner: "host", namespace: "surface" }, headers: strictHeaders },
            { url: `${base}/system-records/record`, query: { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" }, headers: strictHeaders },
            { url: `${base}/permission-mediation-records`, headers },
            { url: `${base}/permission-mediation-records/turn/request`, headers },
        ];
        const readPlugin = () => Promise.all([
            readSessionSystemRecordV1({ ...pluginParams, address: pluginAddress }),
            listSessionSystemRecordsV1({ ...pluginParams, query: { owner: "plugin", namespace: "notes", limit: 10 } }),
        ]);
        const warm = [];
        for (const read of reads) warm.push(await app.inject({ method: "GET", ...read }));
        expect(warm.map(response => response.statusCode)).toEqual(reads.map(() => 200));
        const warmPlugin = await readPlugin();
        expect(warmPlugin.map(result => result.ok)).toEqual([true, true]);

        const writer = await holdSqliteWriteLock();
        let writeSettled = false;
        const blockedWrite = inTx(tx => tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } }))
            .then(() => null, (error: unknown) => error)
            .finally(() => { writeSettled = true; });
        const responses = new Map<number, { statusCode: number; body: string }>();
        let requests: Promise<unknown>[] = [];
        let pluginFinished = false;
        try {
            await inTx(tx => tx.account.findUniqueOrThrow({ where: { id: account.id }, select: { id: true } }), { readOnly: true });
            requests = reads.map(async (read, index) => {
                responses.set(index, await app.inject({ method: "GET", ...read }));
            });
            requests.push(readPlugin().then(results => {
                expect(results).toEqual(warmPlugin);
                pluginFinished = true;
            }));
            // Observation window for the test only: the writer remains held until these reads finish.
            await vi.waitFor(() => {
                expect(reads.map((read, index) => ({ url: read.url, status: responses.get(index)?.statusCode })))
                    .toEqual(reads.map(read => ({ url: read.url, status: 200 })));
                expect(pluginFinished).toBe(true);
            }, { timeout: 1_000 });
            expect(writeSettled).toBe(false);
            expect(reads.map((_, index) => responses.get(index)?.body)).toEqual(warm.map(response => response.body));
        } finally {
            await writer.release();
            await blockedWrite;
            await Promise.all(requests);
            await app.close();
        }

        // A later read observes current committed mode, rather than retaining admission from the warm read.
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "e2ee" } });
        await expect(readSessionSystemRecordV1({ ...baseParams, address })).resolves.toEqual({
            ok: false, code: "plugin_session_record_storage_mode_mismatch",
        });
    });
});
