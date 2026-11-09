import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionAccessGrantRoutes } from "@/app/api/routes/session/registerSessionAccessGrantRoutes";
import { updateSessionMetadataEnvelopeTuple } from "@/app/session/sessionWriteService";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Session grant write contention (PostgreSQL)", () => {
    let originalTransaction: typeof db.$transaction;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        originalTransaction = db.$transaction;
    });
    afterAll(async () => { await db.$disconnect(); });
    afterEach(() => { db.$transaction = originalTransaction; vi.unstubAllEnvs(); });

    for (const contention of ["publication", "foreign Serializable", "retired actor"] as const) {
        for (const operation of ["set", "remove", "context", "metadata consent"] as const) {
            if (contention === "retired actor" && operation !== "set") continue;
            it(`${operation} preserves grant effects amid ${contention} commits`, async () => {
                const prefix = `session-grant-contention-${randomUUID()}`;
                const [owner, member, foreign] = await Promise.all([
                    db.account.create({ data: { publicKey: `${prefix}-owner`, encryptionMode: "plain" } }),
                    db.account.create({ data: { publicKey: `${prefix}-member`, encryptionMode: "plain" } }),
                    db.account.create({ data: { publicKey: `${prefix}-foreign`, encryptionMode: "plain" } }),
                ]);
                const team = await db.team.create({ data: { name: prefix, sessionCreationPolicy: "team_required" } });
                const ownerMetadata = { t: "plain", v: { v: 1 } } as const;
                const session = await db.session.create({ data: {
                    accountId: owner.id, tag: prefix, metadata: JSON.stringify({ v: 1 }), encryptionMode: "plain", currentStorageState: "hosted",
                    ...(operation === "metadata consent" ? { metadataLayoutVersion: 1, ownerMetadata: JSON.stringify(ownerMetadata) } : {}),
                } });
                let brokerMachineId: string | undefined;
                let writer: Promise<unknown> | undefined;
                let writerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
                let interleavings = 0;
                let publicationPending = false;
                try {
                    await db.teamMembership.createMany({ data: [
                        { teamId: team.id, accountId: owner.id, role: "owner", sessionAccessStartsAt: null },
                        { teamId: team.id, accountId: member.id, role: "member", sessionAccessStartsAt: null },
                    ] });
                    if (operation === "remove") await db.sessionTeamGrant.create({ data: {
                        sessionId: session.id, teamId: team.id, accessLevel: "edit", effectiveAt: new Date(),
                    } });
                    let resource: { id: string; revision: number } | undefined;
                    if (operation === "metadata consent") {
                        vi.stubEnv("HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED", "1");
                        const broker = await db.machine.create({ data: {
                            id: randomUUID(), accountId: member.id, active: true, kind: "persistent", metadata: "{}",
                            operationProtocolCapabilities: { providerBrokerIngress: { protocolVersions: [1] } },
                            operationProtocolCapabilitiesRevision: 1,
                        } });
                        brokerMachineId = broker.id;
                        const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: {
                            teamId: team.id, accountId: owner.id,
                        } } });
                        resource = await db.teamCredentialResource.create({ data: {
                            teamId: team.id, custodianAccountId: member.id, displayName: "Grant contention",
                            disclosureCeiling: "brokered_only", sessionUsePolicy: "team_visibility_required", brokerMachineId: broker.id,
                            sourceBindingJson: JSON.stringify({ v: 1, kind: "provider_connection", connectionId: "pc_contention",
                                connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(64)}`, credentialSlotId: "apiKey" }),
                            memberGrants: { create: { teamMembershipId: membership.id, deliveryMode: "brokered" } },
                        } });
                    }
                    await db.$executeRaw`ANALYZE "Account"`;
                    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
                        const callback = args[0];
                        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                        return Reflect.apply(target, receiver, [async (tx: Tx) => {
                            const query = tx.$queryRawUnsafe.bind(tx);
                            const intercepted = new Proxy(query, { async apply(ownerQuery, queryReceiver, values: Parameters<typeof query>) {
                                if (contention === "retired actor" && interleavings === 0 && values[0].startsWith('SELECT "id" FROM "Account"')) {
                                    interleavings++;
                                    // Commit after audience discovery but before entry admission.
                                    // A ReadCommitted-only change with late admission would
                                    // incorrectly preserve the actor's earlier authorization.
                                    await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });
                                }
                                if (contention === "publication" && !publicationPending
                                    && values[0].includes('FROM "Account"') && values[0].includes("FOR UPDATE")) {
                                    // The exclusive entry fence is reused at publication.
                                    const locked = await Reflect.apply(ownerQuery, queryReceiver, values);
                                    interleavings++;
                                    publicationPending = true;
                                    let ready!: (pid: number) => void;
                                    const started = new Promise<number>(resolve => { ready = resolve; });
                                    let settled = false;
                                    writer = inTx(async peer => {
                                        const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                        ready(pid);
                                        return markAccountChanged(peer, { accountId: owner.id, kind: "account", entityId: "grant-peer-publication" });
                                    });
                                    writerOutcome = Promise.allSettled([writer]).finally(() => { settled = true; publicationPending = false; });
                                    const pid = await Promise.race([started, writer.then(() => { throw new Error("Publication missed rendezvous"); })]);
                                    while (!settled) {
                                        const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                            SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                        `;
                                        if (blocked) break;
                                    }
                                    return locked;
                                }
                                return Reflect.apply(ownerQuery, queryReceiver, values);
                            } });
                            const result = await callback(new Proxy(tx, { get(ownerTx, property, txReceiver) {
                                return property === "$queryRawUnsafe" ? intercepted : Reflect.get(ownerTx, property, txReceiver);
                            } }));
                            if (contention === "foreign Serializable") {
                                const [{ readOnly }] = await tx.$queryRaw<Array<{ readOnly: string }>>`
                                    SELECT current_setting('transaction_read_only') AS "readOnly"
                                `;
                                if (readOnly !== "on") {
                                    await originalTransaction(async peer => {
                                        await peer.account.findUniqueOrThrow({ where: { id: foreign.id } });
                                        await peer.account.update({ where: { id: foreign.id }, data: { seq: { increment: 1 } } });
                                    }, { isolationLevel: "Serializable" });
                                    interleavings++;
                                }
                            }
                            return result;
                        }, ...args.slice(1)]);
                    } });
                    if (operation === "metadata consent") {
                        if (!resource) throw new Error("Missing credential fixture");
                        const result = await updateSessionMetadataEnvelopeTuple({
                            mode: "owner_team_credential_binding", actorUserId: owner.id, sessionId: session.id,
                            authentication: { env: process.env, authority: "present_user", authenticationEvidence: [] },
                            metadataLayoutVersion: 1, expectedOwnerMetadata: ownerMetadata, ownerMetadata,
                            sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }), expectedVersion: 0 }, agentState: { ciphertext: null, expectedVersion: 0 },
                            operation: "session.model.set", teamVisibilityGrantConsent: { teamId: team.id },
                            teamCredentialBindings: [{ v: 1, slot: { kind: "provider_model" }, resourceId: resource.id,
                                expectedResourceRevision: resource.revision, deliveryMode: "brokered" }],
                        });
                        expect(result).toMatchObject({ ok: true });
                        expect(await db.sessionTeamCredentialBinding.findFirst({ where: { sessionId: session.id } }))
                            .toMatchObject({ resourceId: resource.id, resourceRevision: resource.revision });
                    } else await withAuthenticatedTestApp(registerSessionAccessGrantRoutes, async app => {
                        const payload = operation === "context"
                            ? { sessionId: session.id, primaryTeamId: team.id }
                            : { sessionId: session.id, subject: { kind: "team", teamId: team.id },
                                ...(operation === "set" ? { accessLevel: "edit", canApprovePermissions: false } : {}) };
                        const response = await app.inject({ method: "POST",
                            url: operation === "context" ? "/v2/sessions/access-context/set" : `/v2/sessions/access-grants/${operation}`,
                            headers: { "x-test-user-id": owner.id }, payload });
                        console.info("C74_SESSION_GRANT_CONTENTION", { operation, contention, status: response.statusCode, interleavings });
                        if (contention === "retired actor") {
                            expect(response.statusCode, response.body).toBe(403);
                            expect(response.json()).toMatchObject({ error: "session_access_forbidden" });
                            return;
                        }
                        expect(response.statusCode, response.body).toBe(200);
                        expect(response.json()).toMatchObject({ changed: true });
                    });
                    if (writerOutcome) for (const outcome of await writerOutcome) {
                        if (outcome.status === "rejected") throw outcome.reason;
                    }
                    expect(interleavings).toBeGreaterThan(0);
                    if (contention === "retired actor") {
                        expect(await db.sessionTeamGrant.count({ where: { sessionId: session.id } })).toBe(0);
                        expect(await db.accountChange.count({ where: { entityId: session.id } })).toBe(0);
                        return;
                    }
                    const grant = await db.sessionTeamGrant.findUnique({ where: {
                        sessionId_teamId: { sessionId: session.id, teamId: team.id },
                    } });
                    if (operation === "remove") expect(grant).toBeNull();
                    else expect(grant).toMatchObject({ accessLevel: "edit", requiredByTeamPolicy: operation === "context" });
                    const changes = await db.accountChange.findMany({ where: { entityId: session.id, kind: "session" }, select: { accountId: true } });
                    expect(changes.map(change => change.accountId)).toContain(member.id);
                } finally {
                    db.$transaction = originalTransaction;
                    if (writerOutcome) await writerOutcome;
                    await db.session.delete({ where: { id: session.id } });
                    await db.team.delete({ where: { id: team.id } });
                    if (brokerMachineId) await db.machine.delete({ where: { id: brokerMachineId } });
                    await db.account.deleteMany({ where: { id: { in: [owner.id, member.id, foreign.id] } } });
                }
            });
        }
    }
});
