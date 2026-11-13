import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type InjectOptions } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { SessionSystemRecordAddress } from "@happier-dev/protocol";

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

    it('finishes the admitted SystemRecord read and refuses the next read after share revocation', async () => {
        const { withSqliteReadSnapshot } = await import('@/storage/prisma');
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
        const collaborator = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: 'record-revocation', encryptionMode: 'plain', metadata: '{}' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const address = { owner: 'host', namespace: 'memory', kind: 'synopsis.v1', localId: 'revocation' } satisfies SessionSystemRecordAddress;
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: collaborator.id, accessLevel: 'edit' } });
        expect((await upsertSessionSystemRecordV1({ actorUserId: collaborator.id, sessionId: session.id, authentication, address,
            content: { t: 'plain', v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: 'private record' } }, expectedRevision: null })).ok).toBe(true);
        await db.sessionGrant.update({ where: { principalKind: 'account', sessionId_accountId: { sessionId: session.id, accountId: collaborator.id } },
            data: { accessLevel: 'view' } });
        const params = { actorUserId: collaborator.id, sessionId: session.id, authentication, address };
        expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: true,
            record: { content: { t: 'plain', v: { synopsis: 'private record' } } } });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.sessionSystemRecord;
        const original = delegate.findFirst.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let paused = false;
        // Instrument only the real storage boundary, after the policy's admission reads.
        Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused) { paused = true; enter(); await release; }
                return await original(...args);
            } });
        const response = readSessionSystemRecordV1(params);
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.sessionGrant.delete({ where: { principalKind: 'account', sessionId_accountId: { sessionId: session.id, accountId: collaborator.id } } });
            resume();
            const result = await response;
            expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: false, code: 'plugin_session_not_found' });
            expect(result).toMatchObject({ ok: true, record: { content: { t: 'plain', v: { synopsis: 'private record' } } } });
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
        }
    });

    it('retains the admitted V1 record mode and rejects a mismatched mode on the next read', async () => {
        const { withSqliteReadSnapshot } = await import('@/storage/prisma');
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'record-mode-currentness', encryptionMode: 'plain', metadata: '{}' } });
        const address = { owner: 'host', namespace: 'memory', kind: 'synopsis.v1', localId: 'mode-currentness' } satisfies SessionSystemRecordAddress;
        const params = { actorUserId: account.id, sessionId: session.id, authentication: createPresentUserSessionAccessAuthentication(), address };
        expect((await upsertSessionSystemRecordV1({ ...params, content: { t: 'plain', v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: 'private plain bytes' } }, expectedRevision: null })).ok).toBe(true);
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.sessionSystemRecord;
        const original = delegate.findFirst.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let paused = false;
        Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused) { paused = true; enter(); await release; }
                return await original(...args);
            } });
        const response = readSessionSystemRecordV1(params);
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.session.update({ where: { id: session.id }, data: { encryptionMode: 'e2ee' } });
            resume();
            const result = await response;
            expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: false, code: 'plugin_session_record_storage_mode_mismatch' });
            expect(result).toMatchObject({ ok: true, record: { content: { t: 'plain', v: { synopsis: 'private plain bytes' } } } });
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
        }
    });

    it('finishes the admitted runtime-principal record and refuses the next read after its binding changes', async () => {
        const { withSqliteReadSnapshot } = await import('@/storage/prisma');
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: crypto.randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        const installationPublicKey = '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo';
        await db.machine.create({ data: { id: machineId, accountId: account.id, kind: 'ephemeral_session_runner', metadata: '{}',
            installationId, installationPublicKey: Buffer.from(installationPublicKey, 'base64url') } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: session.id, machineId, data: 'runner-access-key' } });
        const activation = await db.ephemeralRunnerActivation.create({ data: {
            id: crypto.randomUUID(), creatorAccountId: account.id, creatorTokenEpoch: account.tokenEpoch,
            draftId: crypto.randomUUID(), sessionId: session.id, machineId, state: 'materialized', workspacePolicy: 'choose_on_endpoint',
            homeServerIdentityId: 'srv_record_currentness', activationSigningPublicKey: installationPublicKey,
            authoringCommitment: 'a'.repeat(43), artifact: {}, endpointFactsRecipient: { mode: 'plain', creatorAccountId: account.id },
        } });
        const address = { owner: 'host', namespace: 'memory', kind: 'synopsis.v1', localId: 'runtime-currentness' } satisfies SessionSystemRecordAddress;
        expect((await upsertSessionSystemRecordV1({ actorUserId: account.id, sessionId: session.id,
            authentication: createPresentUserSessionAccessAuthentication(), address,
            content: { t: 'plain', v: { v: 1, seqTo: 1, updatedAtMs: 1, synopsis: 'runtime private record' } }, expectedRevision: null })).ok).toBe(true);
        const params = { actorUserId: account.id, sessionId: session.id, address,
            authentication: { env: process.env, authority: 'account_automation' as const, authenticationEvidence: undefined,
                sessionRuntimePrincipal: { kind: 'ephemeral_session_runner' as const, authority: 'session_runtime' as const,
                    accountId: account.id, activationId: activation.id, sessionId: session.id, machineId,
                    installationId, installationPublicKey, creatorTokenEpoch: account.tokenEpoch } } };
        expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: true, record: { content: { t: 'plain', v: { synopsis: 'runtime private record' } } } });
        const reader = await withSqliteReadSnapshot(async tx => tx);
        const delegate = reader.sessionSystemRecord;
        const original = delegate.findFirst.bind(delegate);
        let enter!: () => void;
        let resume!: () => void;
        const reached = new Promise<void>(resolve => { enter = resolve; });
        const release = new Promise<void>(resolve => { resume = resolve; });
        let paused = false;
        Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true,
            value: async (...args: Parameters<typeof original>) => {
                if (!paused) { paused = true; enter(); await release; }
                return await original(...args);
            } });
        const response = readSessionSystemRecordV1(params);
        try {
            expect(await Promise.race([reached.then(() => 'barrier'), response.then(() => 'response')])).toBe('barrier');
            await db.machine.update({ where: { id: machineId }, data: { installationId: `${installationId}-replaced` } });
            resume();
            const result = await response;
            expect(await readSessionSystemRecordV1(params)).toMatchObject({ ok: false, code: 'plugin_session_not_found' });
            expect(result).toMatchObject({ ok: true, record: { content: { t: 'plain', v: { synopsis: 'runtime private record' } } } });
        } finally {
            resume(); await response;
            Object.defineProperty(delegate, 'findFirst', { configurable: true, writable: true, value: original });
        }
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
        const address = { owner: "host", namespace: "memory", kind: "synopsis.v1", localId: "synopsis" } satisfies SessionSystemRecordAddress;
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
        const reads: InjectOptions[] = [
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
