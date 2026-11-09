import { randomUUID } from "node:crypto";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { resolveAccountVoiceSelection } from "@/app/session/follow/accountFollowService";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerConnectedAccountConfigurationRowsRoutes } from "@/app/account/connectedAccounts/registerConfigurationRowsRoutes";
import { registerSessionArchiveRoutes } from "@/app/api/routes/session/registerSessionArchiveRoutes";
import { registerSessionManagerRoutes } from "@/app/api/routes/session/registerSessionManagerRoutes";
import { registerSessionFollowRoutes } from "@/app/api/routes/session/registerSessionFollowRoutes";
import { registerSessionFollowSourceRoutes } from "@/app/api/routes/session/registerSessionFollowSourceRoutes";
import { applyViewerReadCursorOperation } from "@/app/session/personal/readState";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { SessionManagerSetResultV1Schema } from "@happier-dev/protocol/sessions/follow/sessionManagerV1";
import { ChangeDeliveryMuteResponseV1Schema, ListDeliveryMutesResponseV1Schema } from "@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { sourceKeyForSessionFollowSourceV1 } from '@/app/session/follow/sessionFollowSourceIdentity';
import type { Tx } from "@/storage/inTx";
import { mutateQualifiedConnectedServiceCredential } from "@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository";
import { createQualifiedConnectedAccountGroup } from "@/app/api/routes/connect/qualifiedConnectedAccounts/groupRepository";
import { initEncrypt } from "@/modules/encrypt";
import { ConnectedAccountCatalogRowMutationResponseV1Schema, CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from "@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1";
import { registerConfiguredAgentRowsRoutes } from "@/app/account/agents/registerConfiguredAgentRowsRoutes";
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowMutationResponseV1Schema } from "@happier-dev/protocol/acp/catalog/catalogRowsV1";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";
import { registerPromptLibraryRoutes } from "@/app/account/prompts/registerPromptLibraryRoutes";
import { registerAccountSettingsHistoryRoutes } from "@/app/api/routes/account/registerAccountSettingsHistoryRoutes";
import { registerSessionDraftRoutes } from "@/app/account/sessionDrafts/registerSessionDraftRoutes";
import { registerNotificationChannelRoutes } from "@/app/account/notifications/registerNotificationChannelRoutes";
import { registerRemoteHostCatalogRoutes } from "@/app/account/remoteHosts/registerRemoteHostCatalogRoutes";
import { SessionDraftMutateResponseV1Schema, SessionDraftReadResponseV1Schema } from "@happier-dev/protocol/drafts/sessionDrafts";
import { kvMutate } from "@/app/kv/kvMutate";
import { kvGet } from "@/app/kv/kvGet";
import { createPrismaAccountPetLibraryPersistence } from "@/app/pets/accountPetLibraryPersistence";
import { registerProfileRowsRoutes } from "@/app/api/routes/account/registerProfileRowsRoutes";
import { PROFILE_RECORDS_ROUTE_V1, PROFILE_RECORD_READ_ROUTE_V1, ProfileProviderConversionMutationV1Schema } from "@happier-dev/protocol/profiles/profileRecordV1";
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from "@happier-dev/protocol/providers/connections/connectionRowsV1";
import { upsertAccountHomeDirectoryEntry, deleteAccountHomeDirectoryEntry, setPreferredAccountHome, listAccountHomeDirectory } from "@/app/accountDirectory/accountDirectoryService";
import { HomeConnectionDescriptorV1Schema } from "@happier-dev/protocol/auth/accountDirectory";
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, buildPromptLibraryPhysicalKeyV1, PromptLibraryRowMutationResponseV1Schema,
    PromptLibraryRowReadResponseV1Schema, PromptLibraryRowsListResponseV1Schema } from "@happier-dev/protocol/prompts/library/promptLibraryRowsV1";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account publication transaction admission", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        process.env.HANDY_MASTER_SECRET ??= "r11-disposable-contract";
        await initEncrypt();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(['set', 'remove'] as const)('preserves concurrent Account mute set/%s changes', async secondOperation => {
        const scopes = [0, 1].map(() => ({ kind: 'sender_session' as const, sessionId: randomUUID() }));
        const account = await db.account.create({ data: { encryptionMode: 'plain',
            deliveryMutes: JSON.stringify(secondOperation === 'remove' ? [scopes[1]] : []) } });
        const captured = deferred(), release = deferred();
        const transaction = db.$transaction;
        let firstPid = 0, secondPid = 0;
        let paused = false;
        let transactionCount = 0;
        // Only schedule the real Prisma boundary. Both public HTTP operations,
        // Account admission, list merging and terminal publication remain real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            const index = transactionCount++;
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                if (index === 0) firstPid = pid;
                else secondPid = pid;
                return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                    if (property !== 'account' || index !== 0) return Reflect.get(inner, property, innerReceiver);
                    return new Proxy(inner.account, { get(model, method, modelReceiver) {
                        if (method !== 'findUnique') return Reflect.get(model, method, modelReceiver);
                        return async (...queryArgs: unknown[]) => {
                            const row: unknown = await Reflect.apply(model.findUnique, model, queryArgs);
                            const query = queryArgs[0];
                            if (!paused && typeof query === 'object' && query !== null && 'select' in query
                                && typeof query.select === 'object' && query.select !== null && 'deliveryMutes' in query.select) {
                                paused = true;
                                captured.resolve();
                                await release.promise;
                            }
                            return row;
                        };
                    } });
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionFollowRoutes, async app => {
                const url = '/v2/account/session-delivery-mutes';
                const headers = { 'x-test-user-id': account.id };
                const first = app.inject({ method: 'PUT', url, headers, payload: { scope: scopes[0] } });
                const firstOutcome = Promise.allSettled([first]);
                let secondOutcome: Promise<PromiseSettledResult<Awaited<typeof first>>[]> | undefined;
                try {
                    await Promise.race([captured.promise, first.then(() => { throw new Error('First mute never read its receiver'); })]);
                    let settled = false;
                    const second = app.inject({ method: secondOperation === 'set' ? 'PUT' : 'DELETE', url, headers,
                        payload: { scope: scopes[1] } });
                    secondOutcome = Promise.allSettled([second]).finally(() => { settled = true; });
                    // Before the fix, the peer commits through compatible entry.
                    // After it, the merge holds terminal Account publication and
                    // the peer waits there; either schedule must retain both edits.
                    while (!settled) {
                        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`
                            SELECT ${firstPid} = ANY(pg_blocking_pids(pid)) AS blocked
                            FROM pg_stat_activity WHERE pid = ${secondPid}
                        `;
                        if (rows[0]?.blocked) break;
                    }
                } finally { release.resolve(); }
                const outcomes = [...await firstOutcome, ...await secondOutcome ?? []];
                for (const outcome of outcomes) {
                    if (outcome.status === 'rejected') throw outcome.reason;
                    expect(outcome.value.statusCode).toBe(200);
                    expect(ChangeDeliveryMuteResponseV1Schema.parse(outcome.value.json())).toEqual({ changed: true,
                        disposition: outcome === outcomes[0] || secondOperation === 'set' ? 'muted' : 'unmuted' });
                }
                db.$transaction = transaction;
                const read = await app.inject({ method: 'GET', url, headers });
                expect(read.statusCode).toBe(200);
                const finalScopes = ListDeliveryMutesResponseV1Schema.parse(read.json()).scopes;
                expect(finalScopes).toHaveLength(secondOperation === 'set' ? 2 : 1);
                expect(finalScopes).toEqual(expect.arrayContaining(secondOperation === 'set' ? scopes : [scopes[0]]));
            });
        } finally {
            release.resolve();
            db.$transaction = transaction;
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it("preserves both delivery-mute scopes when different Accounts edit one Session", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const editor = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
            sharedWithUserId: editor.id, accessLevel: "edit" } });
        const captured = deferred(), release = deferred();
        const transaction = db.$transaction;
        let paused = false;
        let firstPid = 0;
        let blockedPeer = false;
        // Schedule only the Prisma boundary: both HTTP writers and their
        // access decisions, scope merging, publication and persistence stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "session") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.session, { get(model, method, modelReceiver) {
                    if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: unknown[]) => {
                        const row = await Reflect.apply(model.findUnique, model, queryArgs);
                        const query = queryArgs[0];
                        if (!paused && typeof query === "object" && query !== null && "select" in query
                            && typeof query.select === "object" && query.select !== null && "deliveryMutes" in query.select) {
                            paused = true;
                            [{ pid: firstPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            captured.resolve();
                            await release.promise;
                        }
                        return row;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerSessionFollowRoutes, async app => {
                const url = `/v2/sessions/${session.id}/delivery-mutes`;
                const scopes = [{ kind: "sender_session", sessionId: session.id }, { kind: "sender_session", sessionId: randomUUID() }];
                const first = app.inject({ method: "PUT", url, headers: { "x-test-user-id": owner.id }, payload: { scope: scopes[0] } });
                await Promise.race([captured.promise, first.then(() => { throw new Error("First writer did not reach its receiver read"); })]);
                let settled = false;
                const second = app.inject({ method: "PUT", url, headers: { "x-test-user-id": editor.id }, payload: { scope: scopes[1] } });
                void second.finally(() => { settled = true; }).catch(() => undefined);
                try {
                    while (!settled) {
                        const [{ waiting }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                            `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                AND $1::int = ANY(pg_blocking_pids(pid))) AS waiting`, firstPid,
                        );
                        // Session editors serialize at the Session resource
                        // fence; an Account-query filter misses that waiter.
                        if (waiting) { blockedPeer = true; break; }
                    }
                } finally { release.resolve(); }
                const responses = await Promise.all([first, second]);
                expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
                expect(blockedPeer).toBe(true);
                for (const response of responses) expect(ChangeDeliveryMuteResponseV1Schema.parse(response.json()))
                    .toEqual({ changed: true, disposition: "muted" });
                db.$transaction = transaction;
                const read = await app.inject({ method: "GET", url, headers: { "x-test-user-id": owner.id } });
                expect(read.statusCode).toBe(200);
                expect(ListDeliveryMutesResponseV1Schema.parse(read.json()).scopes).toEqual(expect.arrayContaining(scopes));
            });
        } finally { release.resolve(); db.$transaction = transaction; }
    });

    it("keeps the ACP row CAS authoritative for concurrent definition writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        await withAuthenticatedTestApp(registerConfiguredAgentRowsRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const payload = { expectedRevision: "absent", source: "fresh", sourceSettingsVersion: 0,
                referencedSavedSecretIds: [], content: { t: "plain", v: { v: 1, definitions: [] } } };
            const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST",
                url: ACP_CATALOG_ROWS_ROUTE_V1, headers, payload })));
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(responses.map(response => AcpCatalogRowMutationResponseV1Schema.parse(response.json()).status).sort())
                .toEqual(["conflict", "updated"]);
            const read = await app.inject({ method: "GET", url: ACP_CATALOG_ROWS_ROUTE_V1, headers });
            expect(read.json()).toEqual({ status: "present", revision: 0, content: payload.content });
        });
    });

    it("keeps the prompt row CAS authoritative for concurrent catalog writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        await withAuthenticatedTestApp(registerPromptLibraryRoutes, async app => {
            const headers = { "x-test-user-id": account.id };
            const url = `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`;
            const payload = { expectedRevision: "absent", sourceSettingsVersion: 0,
                content: { t: "plain", v: { key: "skill-rules", value: { v: 1, rules: [] } } } };
            const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url, headers, payload })));
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(responses.map(response => PromptLibraryRowMutationResponseV1Schema.parse(response.json()).status).sort())
                .toEqual(["conflict", "updated"]);
            const read = await app.inject({ method: "GET", url, headers });
            expect(PromptLibraryRowReadResponseV1Schema.parse(read.json())).toEqual({ status: "present", revision: 0, content: payload.content });
        });
    });

    it.each(["configuration", "acp", "prompt-row", "prompt-list", "settings-history-list", "settings-history-row"] as const)("captures %s reads coherently without joining the SSI predicate graph", async catalog => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        if (catalog.startsWith("settings-history")) {
            await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 0,
                encryptionMode: "plain", settingsDbValue: null, contentKind: "empty" } });
        }
        const transaction = db.$transaction;
        const locked = deferred(), release = deferred();
        const peer = Reflect.apply(transaction, db, [async (tx: Tx) => {
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            locked.resolve();
            await release.promise;
        }, { isolationLevel: "Serializable" }]) as Promise<unknown>;
        await locked.promise;
        let predicateLocks = -1;
        let attempts = 0;
        const locksObserved = deferred();
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                attempts++;
                const result = await callback(tx);
                const [{ count }] = await tx.$queryRaw<Array<{ count: number }>>`
                    SELECT count(*)::int AS count FROM pg_locks
                    WHERE pid = pg_backend_pid() AND mode = 'SIReadLock'
                `;
                predicateLocks = count;
                locksObserved.resolve();
                return result;
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(app => {
                registerConfiguredAgentRowsRoutes(app);
                registerConnectedAccountConfigurationRowsRoutes(app);
                registerPromptLibraryRoutes(app);
                registerAccountSettingsHistoryRoutes(app);
            }, async app => {
                const url = catalog === "acp" ? ACP_CATALOG_ROWS_ROUTE_V1
                    : catalog === "prompt-row" ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`
                    : catalog === "prompt-list" ? PROMPT_LIBRARY_ROWS_ROUTE_V1
                    : catalog === "settings-history-list" ? "/v2/account/settings/history"
                    : catalog === "settings-history-row" ? "/v2/account/settings/history/0"
                    : `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`;
                const response = await app.inject({ method: "GET",
                    url, headers: { "x-test-user-id": account.id } });
                expect(response.statusCode).toBe(200);
                if (catalog === "prompt-list") expect(PromptLibraryRowsListResponseV1Schema.parse(response.json())).toEqual({ status: "listed", rows: [] });
                else if (catalog === "prompt-row") expect(PromptLibraryRowReadResponseV1Schema.parse(response.json())).toEqual({ status: "absent" });
                else if (catalog === "settings-history-list") expect(response.json()).toMatchObject({ snapshots: [{ version: 0 }] });
                else if (catalog === "settings-history-row") expect(response.json()).toMatchObject({ version: 0, content: null });
                else expect(response.json()).toEqual({ status: "absent" });
                // A route may send its captured result before inTx finishes.
                await locksObserved.promise;
                expect(predicateLocks).toBe(0);
                expect(attempts).toBe(1);
            });
        } finally {
            release.resolve();
            db.$transaction = transaction;
            await peer;
        }
    });

    it.each(["prompt-row", "prompt-list", "settings-history-row", "settings-history-list"] as const)(
        "keeps %s in the Account capture when a publisher commits between reads", async catalog => {
            const account = await db.account.create({ data: { encryptionMode: "plain" } });
            const prompt = catalog.startsWith("prompt");
            const transaction = db.$transaction;
            await withAuthenticatedTestApp(app => { registerPromptLibraryRoutes(app); registerAccountSettingsHistoryRoutes(app); }, async app => {
                const headers = { "x-test-user-id": account.id };
                if (prompt) {
                    const response = await app.inject({ method: "POST", url: `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules`, headers,
                        payload: { expectedRevision: "absent", sourceSettingsVersion: 0,
                            content: { t: "plain", v: { key: "skill-rules", value: { v: 1, rules: [] } } } } });
                    expect(response.statusCode).toBe(200);
                    expect(PromptLibraryRowMutationResponseV1Schema.parse(response.json()).status).toBe("updated");
                } else {
                    await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 0,
                        encryptionMode: "plain", settingsDbValue: null, contentKind: "empty" } });
                }
                let published = false;
                // Schedule a real committed publication after Account admission,
                // before the catalog/history SELECT. ReadCommitted would mix revisions.
                db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.account, { get(model, method, modelReceiver) {
                            if (method !== "findUnique") return Reflect.get(model, method, modelReceiver);
                            return async (...queryArgs: unknown[]) => {
                                const captured = await Reflect.apply(model.findUnique, model, queryArgs);
                                if (!published) {
                                    published = true;
                                    await Reflect.apply(transaction, db, [async (peer: Tx) => {
                                        await peer.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                        if (prompt) await peer.userKVStore.update({ where: { accountId_key: {
                                            accountId: account.id, key: buildPromptLibraryPhysicalKeyV1("skill-rules") } }, data: { version: 1 } });
                                        else await peer.accountSettingsSnapshot.update({ where: { accountId_version: {
                                            accountId: account.id, version: 0 } }, data: { version: 1 } });
                                    }]);
                                }
                                return captured;
                            };
                        } });
                    } })), ...args.slice(1)]);
                } });
                try {
                    const response = await app.inject({ method: "GET", headers, url: catalog === "prompt-row"
                        ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules` : catalog === "prompt-list" ? PROMPT_LIBRARY_ROWS_ROUTE_V1
                        : catalog === "settings-history-row" ? "/v2/account/settings/history/0" : "/v2/account/settings/history" });
                    expect(response.statusCode).toBe(200);
                    expect(published).toBe(true);
                    if (catalog === "prompt-row") expect(PromptLibraryRowReadResponseV1Schema.parse(response.json())).toMatchObject({ status: "present", revision: 0 });
                    else if (catalog === "prompt-list") expect(PromptLibraryRowsListResponseV1Schema.parse(response.json())).toMatchObject({ rows: [{ revision: 0 }] });
                    else if (catalog === "settings-history-row") expect(response.json()).toMatchObject({ version: 0 });
                    else expect(response.json()).toMatchObject({ snapshots: [{ version: 0 }] });
                } finally { db.$transaction = transaction; }
            });
        },
    );

    it.each(["configuration", "mode-change", "archive", "archive-active", "unarchive", "credential", "credential-mode-change", "group", "acp", "acp-mode-change", "prompt", "prompt-mode-change",
        "manager", "manager-cas", "manager-inactive", "follow", "follow-remove", "voice", "follow-preferences", "follow-source", "follow-source-remove", "read-mark-read", "read-mark-unread", "read-advance",
        "delivery-mute", "delivery-mute-remove", "delivery-mute-inactive",
        "delivery-mute-session", "delivery-mute-session-remove", "delivery-mute-session-inactive",
        "delivery-mute-session-shared-revoked", "delivery-mute-session-shared-downgraded",
        "draft-account", "draft-session", "draft-session-inactive", "draft-session-mode-change", "draft-session-shared-revoked",
        "notification", "notification-mode-change", "remote-host", "remote-host-mode-change", "kv", "pet-remove", "profile", "profile-mode-change", "profile-conversion",
        "directory-upsert", "directory-remove", "directory-preferred"] as const)(
        "settles %s after a held Account writer commits", async operation => {
            const account = await db.account.create({ data: { encryptionMode: "plain" } });
            const pet = operation === "pet-remove" ? await db.accountPetPackage.create({ data: {
                id: randomUUID(), accountId: account.id, packageFormat: "fixture", manifest: {}, digest: "fixture", sizeBytes: 0, origin: {},
            } }) : null;
            const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: "srv_r34_fixture",
                canonicalServerUrl: "https://r34.test", revision: 1, endpoints: [{ kind: "https", url: "https://r34.test" }] });
            if (operation === "directory-remove" || operation === "directory-preferred") {
                await db.accountHomeDirectoryEntry.create({ data: { accountId: account.id, homeServerIdentityId: descriptor.homeServerIdentityId,
                    label: "Fixture", canonicalServerUrl: descriptor.canonicalServerUrl, connectionDescriptor: descriptor } });
            }
            if (operation === "directory-remove") await db.account.update({ where: { id: account.id },
                data: { preferredHomeServerIdentityId: descriptor.homeServerIdentityId } });
            const relationOperation = operation.startsWith("manager") || operation.startsWith("follow")
                || operation === "voice" || operation.startsWith("read-") || operation.startsWith("delivery-mute");
            const sharedMute = operation === "delivery-mute-session-shared-revoked" || operation === "delivery-mute-session-shared-downgraded";
            const draftOwner = operation === "draft-session-shared-revoked" || sharedMute
                ? await db.account.create({ data: { encryptionMode: "plain" } }) : account;
            const session = operation === "archive" || operation === "archive-active" || operation === "unarchive"
                || relationOperation || operation.startsWith("draft-session")
                ? await db.session.create({ data: { accountId: draftOwner.id, tag: randomUUID(), metadata: "{}",
                    encryptionMode: "plain", active: false, seq: 10, archivedAt: operation === "unarchive" ? new Date(123) : null } })
                : null;
            if ((operation === "draft-session-shared-revoked" || sharedMute) && session) await db.sessionShare.create({ data: {
                sessionId: session.id, sharedWithUserId: account.id, sharedByUserId: draftOwner.id, accessLevel: sharedMute ? "edit" : "view",
            } });
            const lead = relationOperation ? await db.session.create({ data: { accountId: account.id,
                tag: randomUUID(), metadata: "{}", encryptionMode: "plain", active: false } }) : null;
            if (session && operation === "manager-cas") await db.sessionFollowEdge.create({ data: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
                sourceSessionId: session.id, destinationSessionId: lead!.id, relation: 'manager', managerSourceSessionId: session.id,
                policyJson: JSON.stringify({ preset: 'important' }),
            } });
            if (session && operation === "follow-remove") await db.accountSessionFollow.create({ data: {
                accountId: account.id, sessionId: session.id, following: true, followPolicy: JSON.stringify({ preset: 'custom', events: {} }), includeInVoice: false,
            } });
            if (session && operation === "follow-source-remove") await db.sessionFollowEdge.create({ data: {
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: session.id }),
                sourceSessionId: session.id, destinationSessionId: lead!.id, policyJson: JSON.stringify({ preset: 'quiet' }),
            } });
            if (session && operation.startsWith("read-")) await db.accountSessionReadState.create({ data: {
                accountId: account.id, sessionId: session.id, lastViewedSessionSeq: operation === "read-mark-unread" ? 10 : 0,
            } });
            const transaction = db.$transaction;
            // Count attempts that reach an Account lock/write. A replay may
            // refuse a revoked shared Session before reaching that boundary.
            let attempts = 0;
            let waits = 0;
            let interleaved = false;
            let expectedWait: boolean | undefined;
            const observationName = `r34-${randomUUID()}`;
            const failures: string[] = [];
            const peerChangesAccountKey = (operation === "mode-change" || operation.endsWith("-mode-change"))
                && operation !== "draft-session-mode-change";
            const assertInterleaving = () => {
                expect(interleaved).toBe(true);
                expect(expectedWait).toBeDefined();
                expect(waits).toBe(expectedWait ? 1 : 0);
                if (operation.startsWith("directory-")) {
                    // Serializable may reject the first captured version, but
                    // one real competing commit must converge on replay.
                    expect(failures.length).toBeLessThanOrEqual(1);
                    for (const code of failures) expect(["P2034", "P2010"]).toContain(code);
                    expect(attempts).toBe(failures.length + 1);
                } else if (operation === "draft-session-shared-revoked") {
                    expect(failures).toEqual(["P2010"]);
                    expect(attempts).toBe(1);
                } else {
                    expect(failures).toEqual([]);
                    expect(attempts).toBe(1);
                }
            };
            if (session && operation === "delivery-mute-remove") await db.account.update({
                where: { id: account.id }, data: { deliveryMutes: JSON.stringify([{ kind: "sender_session", sessionId: session.id }]) },
            });
            if (session && operation === "delivery-mute-session-remove") await db.session.update({
                where: { id: session.id }, data: { deliveryMutes: JSON.stringify([{ kind: "sender_session", sessionId: session.id }]) },
            });
            // Only the Prisma transport is scheduled. HTTP, mode admission,
            // Account fences, lifecycle effects and publication execute unchanged.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let observedAttempt = false;
                    const interleave = async (run: () => Promise<unknown>, keyShare: boolean): Promise<unknown> => {
                        if (!observedAttempt) { observedAttempt = true; attempts++; }
                        if (interleaved) return run();
                        interleaved = true;
                        // Entry admission already attributed this transaction. Retag
                        // the consumed boundary without establishing a read snapshot.
                        await tx.$executeRawUnsafe(`SET LOCAL application_name = '${observationName}'`);
                        // A non-key Account UPDATE is compatible with KEY
                        // SHARE. A key update, stronger lock or UPDATE waits.
                        expectedWait = !keyShare || peerChangesAccountKey;
                        const locked = deferred(), release = deferred();
                        const peer = Reflect.apply(transaction, db, [async (peerTx: Tx) => {
                            if (peerChangesAccountKey) await acquireAccountSessionOwnerMetadataFenceInTx(peerTx, account.id, "exclusive");
                            await peerTx.account.update({ where: { id: account.id }, data: peerChangesAccountKey
                                ? { encryptionMode: "e2ee", ...createSignedAccountContentBinding() }
                                : operation === "manager-inactive" || operation === "delivery-mute-inactive" || operation === "delivery-mute-session-inactive"
                                    ? { status: "disabled", seq: { increment: 1 } }
                                : { seq: { increment: 1 } } });
                            if (operation === "archive-active" && session) {
                                await peerTx.session.update({ where: { id: session.id }, data: { active: true } });
                            }
                            if (operation === "draft-session-inactive") {
                                await peerTx.account.update({ where: { id: account.id }, data: { status: "disabled" } });
                            }
                            if (operation === "draft-session-mode-change" && session) {
                                await peerTx.session.update({ where: { id: session.id }, data: { encryptionMode: "e2ee" } });
                            }
                            if (operation === "draft-session-shared-revoked" && session) {
                                await peerTx.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: account.id } });
                            }
                            if (sharedMute && session) {
                                if (operation === "delivery-mute-session-shared-revoked") {
                                    await peerTx.sessionShare.deleteMany({ where: { sessionId: session.id, sharedWithUserId: account.id } });
                                } else {
                                    await peerTx.sessionShare.updateMany({ where: { sessionId: session.id, sharedWithUserId: account.id }, data: { accessLevel: "view" } });
                                }
                            }
                            locked.resolve();
                            await release.promise;
                        }]) as Promise<unknown>;
                        const peerOutcome = Promise.allSettled([peer]);
                        let waiting: Promise<unknown> | undefined;
                        let queryOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
                        try {
                            await Promise.race([locked.promise, peer.then(() => { throw new Error("Peer exited before its Account write"); })]);
                            let settled = false;
                            waiting = run();
                            queryOutcome = Promise.allSettled([waiting]).finally(() => { settled = true; });
                            while (!settled) {
                                const [{ waiting: blocked }] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                                    `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                                        AND application_name = $1 AND wait_event_type = 'Lock') AS waiting`, observationName,
                                );
                                if (blocked) { waits++; break; }
                            }
                        } finally {
                            release.resolve();
                            await peerOutcome;
                            if (queryOutcome) await queryOutcome;
                        }
                        await peer;
                        return waiting;
                    };
                    const observe = (query: unknown, keyShare: boolean) => observeLazyPrismaQuery(query, () => ({
                        started() {},
                        settled(succeeded, error) {
                            if (!succeeded) failures.push(typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown");
                        },
                    }), undefined, consume => interleave(consume, keyShare));
                    return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                        if (property === "account") return new Proxy(inner.account, { get(model, method, modelReceiver) {
                            if (method !== "update" && method !== "updateMany") return Reflect.get(model, method, modelReceiver);
                            return (...queryArgs: unknown[]) => observe(Reflect.apply(model[method], model, queryArgs), false);
                        } });
                        if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                        return (query: string, ...values: unknown[]) => {
                            const result = inner.$queryRawUnsafe(query, ...values);
                            return query.includes('FROM "Account"') && query.includes("FOR ") || query.includes('UPDATE "Account"')
                                ? observe(result, query.includes("FOR KEY SHARE")) : result;
                        };
                    } }));
                }, ...args.slice(1)]);
            } });
            try {
                await withAuthenticatedTestApp(app => {
                    registerConnectedAccountConfigurationRowsRoutes(app);
                    registerSessionArchiveRoutes(app);
                    registerSessionManagerRoutes(app);
                    registerSessionFollowRoutes(app);
                    registerSessionFollowSourceRoutes(app);
                    registerConfiguredAgentRowsRoutes(app);
                    registerPromptLibraryRoutes(app);
                    registerSessionDraftRoutes(app);
                    registerNotificationChannelRoutes(app);
                    registerRemoteHostCatalogRoutes(app);
                    registerProfileRowsRoutes(app);
                }, async app => {
                    const startedAt = Date.now();
                    if (operation.startsWith("directory-")) {
                        if (operation === "directory-upsert") {
                            expect(await upsertAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId: descriptor.homeServerIdentityId,
                                label: "Fixture", connectionDescriptor: descriptor })).toMatchObject({ preferred: true });
                        } else if (operation === "directory-remove") {
                            await deleteAccountHomeDirectoryEntry({ accountId: account.id, homeServerIdentityId: descriptor.homeServerIdentityId });
                        } else {
                            expect(await setPreferredAccountHome({ accountId: account.id, homeServerIdentityId: descriptor.homeServerIdentityId }))
                                .toMatchObject({ preferredHomeServerIdentityId: descriptor.homeServerIdentityId });
                        }
                        expect(await listAccountHomeDirectory(account.id)).toMatchObject(operation === "directory-remove"
                            ? { homes: [] } : { preferredHomeServerIdentityId: descriptor.homeServerIdentityId });
                        assertInterleaving();
                        return;
                    }
                    if (operation === "profile-conversion") {
                        const response = await app.inject({ method: "POST", url: "/v1/account/entity-rows/profiles/provider-conversion",
                            headers: { "x-test-user-id": account.id }, payload: ProfileProviderConversionMutationV1Schema.parse({
                                operation: "provider-conversion", expectedAccountMode: "plain", expectedSettingsVersion: 0,
                                expectedProfileTransferRevision: "absent", expectedReferenceGuardRevision: "absent", profileCensus: [], mutations: [],
                                providerMutation: { expectedRevision: "absent", sourceSettingsVersion: 0,
                                    content: { t: "plain", v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 }, referencedSavedSecretIds: [], savedSecretRevisions: [] },
                                nextSettings: { t: "plain", v: {} },
                            }) });
                        expect(response.statusCode).toBe(200);
                        expect(response.json()).toMatchObject({ status: "updated", settingsVersion: 1, providerRevision: 0 });
                        assertInterleaving();
                        return;
                    }
                    if (operation.startsWith("profile")) {
                        const id = randomUUID();
                        const content = { t: "plain", v: { v: 1, id, enabled: true, promptStack: [], skillSeeds: [], secretBindings: {},
                            definition: { kind: "inline", profile: { v: 2, id, name: "Held-writer profile", extraEnvironmentVariables: [],
                                defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 } } } };
                        const headers = { "x-test-user-id": account.id };
                        const response = await app.inject({ method: "POST", url: PROFILE_RECORDS_ROUTE_V1, headers,
                            payload: { operation: "create", id, expectedRevision: "absent", content, referencedSavedSecretIds: [] } });
                        expect(response.statusCode).toBe(200);
                        expect(response.json()).toMatchObject(operation.endsWith("-mode-change") ? { status: "account-mode-mismatch" } : { status: "updated", revision: 0 });
                        db.$transaction = transaction;
                        const read = await app.inject({ method: "POST", url: PROFILE_RECORD_READ_ROUTE_V1, headers, payload: { id } });
                        expect(read.json()).toMatchObject(operation.endsWith("-mode-change") ? { status: "absent" } : { status: "present", content });
                        assertInterleaving();
                        return;
                    }
                    if (operation === "kv") {
                        const key = `contention-${randomUUID()}`;
                        const result = await kvMutate({ uid: account.id }, [{ key, value: "Zml4dHVyZQ==", version: -1 }]);
                        expect(result.success).toBe(true);
                        expect(await kvGet({ uid: account.id }, key)).toEqual({ key, value: "Zml4dHVyZQ==", version: 0 });
                        assertInterleaving();
                        db.$transaction = transaction;
                        const contenders = await Promise.all([0, 1].map(() => kvMutate({ uid: account.id }, [{ key, value: null, version: 0 }])));
                        expect(contenders.map(result => result.success).sort()).toEqual([false, true]);
                        expect(await kvGet({ uid: account.id }, key)).toBeNull();
                        expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).version).toBe(1);
                        return;
                    }
                    if (operation === "pet-remove" && pet) {
                        const persistence = createPrismaAccountPetLibraryPersistence();
                        expect(await persistence.deleteAccountPet(account.id, pet.id)).toMatchObject({ ok: true });
                        expect(await persistence.readAccountPet(account.id, pet.id)).toBeNull();
                        expect((await db.accountPetPackage.findUniqueOrThrow({ where: { id: pet.id } })).deletedAt).not.toBeNull();
                        assertInterleaving();
                        return;
                    }
                    if (operation.startsWith("draft-")) {
                        const address = session ? { kind: "session" as const, sessionId: session.id }
                            : { kind: "newSession" as const, draftId: randomUUID() };
                        const mutationId = randomUUID();
                        const content = { t: "plain" as const, v: { v: 1, address, document: {
                            v: 1, composer: { text: { mutationId, value: "held-writer draft" },
                                mentions: { mutationId, value: [] }, attachments: { mutationId, value: [] } },
                            target: address.kind === "newSession" ? { kind: "newSession", authoring: {} }
                                : { kind: "session", routing: { recipient: { mutationId, value: null },
                                    agentContinuation: { mutationId, value: null }, executionRunDelivery: { mutationId, value: null } } }, extensions: {},
                        } } };
                        const headers = { "x-test-user-id": account.id, "x-happier-account-stored-content-protocol": "4" };
                        const response = await app.inject({ method: "POST", url: "/v1/account/session-drafts/mutate", headers,
                            payload: { address, expectedRevision: "absent", content } });
                        console.info("R34_DRAFT_PUBLICATION", { operation, attempts, waits, failures, status: response.statusCode });
                        const unavailable = operation === "draft-session-inactive" || operation === "draft-session-shared-revoked";
                        const refused = unavailable || operation === "draft-session-mode-change";
                        expect(response.statusCode).toBe(unavailable ? 404 : operation === "draft-session-mode-change" ? 400 : 200);
                        if (refused) {
                            expect(response.json()).toEqual({ error: unavailable ? "session_unavailable" : "invalid_content_mode" });
                            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
                        } else {
                            expect(SessionDraftMutateResponseV1Schema.parse(response.json())).toMatchObject({ status: "updated", record: { revision: 0, content } });
                            // Only the mutation is interleaved; the real reader independently consumes its persisted result.
                            db.$transaction = transaction;
                            const read = await app.inject({ method: "POST", url: "/v1/account/session-drafts/read", headers, payload: { address } });
                            expect(SessionDraftReadResponseV1Schema.parse(read.json())).toMatchObject({ status: "present", record: { revision: 0, content } });
                        }
                        assertInterleaving();
                        return;
                    }
                    if (operation.startsWith("notification") || operation.startsWith("remote-host")) {
                        const remote = operation.startsWith("remote-host");
                        const mutation = { expectedRevision: "absent", sourceSettingsVersion: 0,
                            content: { t: "plain", v: remote ? { v: 1, hosts: [] } : { v: 1, channels: [] } },
                            ...(remote ? { referencedSavedSecretRevisions: [] } : { savedSecretRevisions: [] }) };
                        const headers = { "x-test-user-id": account.id };
                        const url = `/v1/account/entity-rows/${remote ? "remote-hosts" : "notification-channels"}`;
                        const response = await app.inject({ method: "POST", url, headers, payload: remote ? { mutation } : mutation });
                        console.info("R34_CATALOG_PUBLICATION", { operation, attempts, waits, failures, status: response.statusCode });
                        expect(response.statusCode).toBe(200);
                        expect(response.json()).toMatchObject(operation.endsWith("-mode-change") ? { status: "account-mode-mismatch" } : { status: "updated", revision: 0 });
                        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(operation.endsWith("-mode-change") ? 0 : 1);
                        assertInterleaving();
                        return;
                    }
                    if (operation.startsWith("delivery-mute") && session) {
                        const scope = { kind: "sender_session", sessionId: session.id };
                        const sessionReceiver = operation.startsWith("delivery-mute-session");
                        const url = sessionReceiver ? `/v2/sessions/${session.id}/delivery-mutes` : "/v2/account/session-delivery-mutes";
                        const removing = operation.endsWith("-remove");
                        const inactive = operation.endsWith("-inactive");
                        const response = await app.inject({ method: removing ? "DELETE" : "PUT",
                            url,
                            headers: { "x-test-user-id": account.id }, payload: { scope },
                        });
                        console.info("B4_DELIVERY_MUTE_PUBLICATION", { operation, attempts, waits, failures, status: response.statusCode });
                        expect(response.statusCode).toBe(inactive ? 403 : sharedMute ? 404 : 200);
                        if (inactive || sharedMute) {
                            expect(response.json()).toEqual({ error: inactive ? "account_inactive" : "session_not_found" });
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).deliveryMutes).toBeNull();
                            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).deliveryMutes).toBeNull();
                        } else {
                            expect(ChangeDeliveryMuteResponseV1Schema.parse(response.json())).toEqual({
                                changed: true, disposition: removing ? "unmuted" : "muted",
                            });
                            const read = await app.inject({ method: "GET", url,
                                headers: { "x-test-user-id": account.id } });
                            expect(read.statusCode).toBe(200);
                            expect(ListDeliveryMutesResponseV1Schema.parse(read.json())).toEqual({ scopes: removing ? [] : [scope] });
                        }
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(inactive || sharedMute ? 1 : 2);
                        assertInterleaving();
                        return;
                    }
                    if (relationOperation && session && lead) {
                        const manager = operation.startsWith("manager");
                        const source = operation.startsWith("follow-source");
                        if (operation.startsWith("read-")) {
                            const result = await applyViewerReadCursorOperation({ accountId: account.id, sessionId: session.id,
                                authentication: createPresentUserSessionAccessAuthentication({ env: {} }),
                                operation: operation === "read-mark-read" ? { kind: "mark-read" }
                                    : operation === "read-mark-unread" ? { kind: "mark-unread" }
                                    : { kind: "advance", lastViewedSessionSeq: 5 },
                            });
                            console.info("R27_READ_PUBLICATION", { operation, attempts, waits, failures,
                                ok: result.ok, durationMs: Date.now() - startedAt });
                            expect(result).toMatchObject({ ok: true });
                            const frontier = await db.accountSessionReadState.findUniqueOrThrow({ where: {
                                accountId_sessionId: { accountId: account.id, sessionId: session.id },
                            } });
                            expect(frontier.lastViewedSessionSeq).toBe(operation === "read-mark-read" ? 10 : operation === "read-advance" ? 5 : 9);
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBeGreaterThan(1);
                            assertInterleaving();
                            return;
                        }
                        const response = await app.inject({
                            method: operation.endsWith("-remove") ? "DELETE" : manager ? "POST" : "PUT",
                            url: manager ? `/v1/sessions/${session.id}/manager`
                                : source ? `/v2/sessions/${lead.id}/follows/sessions/${session.id}`
                                : operation === "voice" ? "/v2/account/session-follow-voice-inclusions"
                                : operation === "follow-preferences" ? "/v2/account/session-follow-preferences"
                                : `/v2/sessions/${session.id}/follow`,
                            headers: { "x-test-user-id": account.id },
                            ...(operation.endsWith("-remove") ? {} : { payload: manager
                                ? { managerSessionId: operation === "manager-cas" ? null : lead.id, expectedManagerSessionId: null }
                                : source ? { policy: { preset: 'quiet' } }
                                : operation === "voice" ? { sessionIds: [session.id] }
                                : operation === "follow-preferences" ? { assigned: false, direct: false, team: false, group: false }
                                : { notificationLevel: "important", includeInVoice: false } }),
                        });
                        console.info("R27_RELATION_PUBLICATION", { operation, attempts, waits, failures,
                            status: response.statusCode, durationMs: Date.now() - startedAt });
                        expect(response.statusCode).toBe(operation === "manager-cas" ? 409 : operation === "manager-inactive" ? 403 : 200);
                        if (operation === "manager-inactive") {
                            expect(SessionManagerSetResultV1Schema.parse(response.json())).toEqual({ ok: false, error: "manager_forbidden", reason: "read" });
                            expect(await db.sessionFollowEdge.count({ where: { managerSourceSessionId: session.id } })).toBe(0);
                            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
                            assertInterleaving();
                            return;
                        }
                        if (manager) {
                            expect(SessionManagerSetResultV1Schema.parse(response.json())).toMatchObject(operation === "manager-cas"
                                ? { ok: false, error: "manager_cas_conflict" } : { ok: true, managerSessionId: lead.id });
                            expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: session.id } }))
                                .toMatchObject({ relation: 'manager', destinationSessionId: lead.id });
                        } else if (source) {
                            expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: lead.id, sourceSessionId: session.id } }))
                                .toBe(operation === "follow-source-remove" ? 0 : 1);
                        } else if (operation === "follow-preferences") {
                            expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({
                                sessionAutoFollowAssigned: false, sessionAutoFollowDirect: false,
                                sessionAutoFollowTeam: false, sessionAutoFollowGroup: false,
                            });
                        } else {
                            const follow = await db.accountSessionFollow.findUniqueOrThrow({ where: {
                                accountId_sessionId: { accountId: account.id, sessionId: session.id },
                            } });
                            expect(follow).toMatchObject({ following: operation !== "follow-remove" });
                            expect(resolveAccountVoiceSelection(follow) !== null).toBe(operation === "voice");
                        }
                        const committedCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
                        if (operation === "manager-cas") expect(committedCursor).toBe(1);
                        else expect(committedCursor).toBeGreaterThan(1);
                        assertInterleaving();
                        return;
                    }
                    if (operation === "group" || operation === "credential" || operation === "credential-mode-change") {
                        const service = { pluginId: "fixture.r11", localId: "account-publication" };
                        const result = operation === "group"
                            ? await createQualifiedConnectedAccountGroup({ accountId: account.id, service, group: { groupId: "owned" } })
                            : await mutateQualifiedConnectedServiceCredential({ accountId: account.id,
                                ref: { service, accountId: "owned" }, expectedCredentialRevision: null,
                                authenticationModeId: "oauth", content: { t: "plain", v: { fixture: true } }, metadata: { scopes: [] } });
                        console.info("R11_ACCOUNT_PUBLICATION", { operation, attempts, waits, failures,
                            status: result.status, durationMs: Date.now() - startedAt });
                        expect(result.status).toBe(operation === "credential-mode-change" ? "storage_mode_mismatch" : "written");
                        if (operation === "credential-mode-change") {
                            expect(await db.serviceAccountToken.count({ where: { accountId: account.id } })).toBe(0);
                        }
                        assertInterleaving();
                        return;
                    }
                    const acp = operation.startsWith("acp");
                    const prompt = operation.startsWith("prompt");
                    const response = await app.inject({ method: "POST",
                        url: session ? `/v2/sessions/${session.id}/${operation === "archive-active" ? "archive" : operation}` : acp ? ACP_CATALOG_ROWS_ROUTE_V1
                            : prompt ? `${PROMPT_LIBRARY_ROWS_ROUTE_V1}/skill-rules` : `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`,
                        headers: { "x-test-user-id": account.id },
                        ...(session ? {} : { payload: { expectedRevision: "absent", sourceSettingsVersion: 0,
                            ...(acp ? { source: "fresh" } : {}),
                            referencedSavedSecretIds: [],
                            content: { t: "plain", v: acp ? { v: 1, definitions: [] }
                                : prompt ? { key: "skill-rules", value: { v: 1, rules: [] } } : { key: "configurations", value: { v: 1, entries: [] } } } } }),
                    });
                    console.info("R11_ACCOUNT_PUBLICATION", { operation, attempts, waits, failures,
                        status: response.statusCode, durationMs: Date.now() - startedAt });
                    if (operation === "archive-active" && session) {
                        expect(response.statusCode).toBe(409);
                        expect(response.json()).toEqual({ error: "session-active" });
                        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                            .toMatchObject({ active: true, archivedAt: null });
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq).toBe(1);
                        assertInterleaving();
                        return;
                    }
                    expect(response.statusCode).toBe(200);
                    if (session) {
                        expect(response.json()).toMatchObject({ success: true });
                        expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).archivedAt === null)
                            .toBe(operation === "unarchive");
                        // The lifecycle write must commit its recipient cursor as
                        // well as its state after the unrelated publisher releases.
                        expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq)
                            .toBeGreaterThanOrEqual(2);
                    } else {
                        const modeChanged = operation === "mode-change" || operation.endsWith("-mode-change");
                        expect((acp ? AcpCatalogRowMutationResponseV1Schema : prompt ? PromptLibraryRowMutationResponseV1Schema : ConnectedAccountCatalogRowMutationResponseV1Schema).parse(response.json())).toMatchObject(
                            modeChanged ? { status: "account-mode-mismatch" } : { status: "updated", revision: 0 },
                        );
                        expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(modeChanged ? 0 : 1);
                    }
                    assertInterleaving();
                });
            } finally { db.$transaction = transaction; }
        },
    );
});
