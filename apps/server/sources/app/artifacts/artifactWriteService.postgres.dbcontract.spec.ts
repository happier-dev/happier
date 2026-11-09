import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent } from "@happier-dev/protocol";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import type { Tx } from "@/storage/inTx";
import { updateArtifactHttpMutation } from "./artifactMutationHttpResponse";
import { createArtifact, createArtifactTx, deleteArtifact, updateArtifact, updateArtifactTx } from "./artifactWriteService";
import { readArtifactStorageUsageInTx } from "./artifactStorageService";
import { inTx } from "@/storage/inTx";
import { readArtifactForCaller, removeArtifactAccessGrantInTx, setArtifactAccessGrantInTx } from "./artifactAccessService";
import { decideArtifactEditProposalInTx } from "./artifactEditProposalService";
import { createDiscussion, postDiscussionMessage } from "@/app/discussions/mutations";
import { buildDiscussionMutationRequestBodyV1 } from "@happier-dev/protocol/discussions/api";
import { createDiscussionMessageRefV1 } from "@happier-dev/protocol/discussions/messageRefs";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { admitTeamMemberInTx } from '@/app/teams/memberships/membershipService';
import { publishTeamChangedInTx } from '@/app/teams/teamChanges';
import { acquireAccountSessionOwnerMetadataFenceInTx } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { ExternalActionExecutionAuthorizationBindingV1Schema, createDeploymentCandidatePublicationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from '@/app/deployments/deploymentEnvironmentService';
import { createDeploymentCandidateArtifactMutationGuard } from '@/app/deployments/deploymentPreparationAuthorization';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';

const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));

function waitForDatabasePause<T>(operation: Promise<T>, paused: Promise<void>): Promise<void> {
    return Promise.race([paused, operation.then(() => { throw new Error("Artifact operation finished before its database interleaving boundary"); })]);
}

async function plainArtifact(accountId: string) {
    return db.artifact.create({ data: {
        id: randomUUID(), accountId, header: bytes({ kind: "approval_request.v1" }), body: bytes({ status: "open" }),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
    } });
}

/** Advance a genuine peer after audience discovery but before the first Account lock. */
function beforeArtifactAccountLock(artifactId: string, peer: () => Promise<void>) {
    const transaction = db.$transaction;
    let advanced = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let addressed = false;
            return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === "artifact") return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "findFirst") return operation;
                    return (...queryArgs: Parameters<typeof tx.artifact.findFirst>) => {
                        if (queryArgs[0]?.where?.id === artifactId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
                if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (addressed && !advanced && query.includes('FROM "Account"') && query.includes("FOR ")) {
                        advanced = true;
                        await peer();
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } }));
        }, ...args.slice(1)]);
    } });
    return () => { db.$transaction = transaction; expect(advanced).toBe(true); };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Artifact writes under PostgreSQL publication contention", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it.each(['create', 'refresh'] as const)('admits pending Environment Team readers before candidate %s with recovery disabled', async operation => {
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '');
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
        const serverId = `srv_${'e'.repeat(32)}`;
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', serverId);
        try {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
            const team = await db.team.create({ data: { name: randomUUID() } });
            await db.teamMembership.createMany({ data: [
                { teamId: team.id, accountId: owner.id, role: 'owner' },
                { teamId: team.id, accountId: reader.id, role: 'member' },
            ] });
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId, requestKey: randomUUID(), name: 'Candidate publication', audience: [],
            }));
            if (!source.ok) throw new Error(source.error);
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
                metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux',
                    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
            const definition = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
                header: bytes({ kind: 'deployment-environment.v1', title: 'Environment audience' }),
                body: bytes({ body: JSON.stringify(createDeploymentEnvironmentDetailV1().content) }),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!definition.ok) throw new Error(definition.error);
            expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id,
                artifactId: definition.artifact.id, principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' })))
                .toMatchObject({ ok: true });
            const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
                serverId, projectSourceId: source.source.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machine.id, requestKey: randomUUID(),
                contentArtifactId: definition.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            }));
            if (!environment.ok) throw new Error(environment.error);
            // This owner-level contract starts at an already admitted binding;
            // the SQLite signed-HTTP contract exercises its signature boundary.
            const root = { accountId: owner.id, authentication: { kind: 'account' as const, tokenEpoch: owner.tokenEpoch },
                serverIdentityId: serverId, custodianAccountId: owner.id, machineId: machine.id,
                installationId: machine.installationId!, actionId: 'deployments.deploy' as const,
                requestId: randomUUID(), requestEnvelopeDigest: 'd'.repeat(43), target: { kind: 'machine' as const, machineId: machine.id } };
            const scope = createDeploymentCandidatePublicationV1({ ...root, environmentId: environment.environmentId,
                source: { id: source.source.id, revision: source.source.revision } });
            const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({ ...root, deploymentCandidatePublication: scope });
            const content = { id: scope.contentArtifactId, kind: 'v1:other:deployment-receipt.v1',
                header: encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Candidate' }),
                body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
            const createInput = { actorUserId: owner.id, artifactId: content.id, kind: content.kind,
                header: privacyKit.decodeBase64(content.header), body: privacyKit.decodeBase64(content.body),
                dataEncryptionKey: privacyKit.decodeBase64(content.dataEncryptionKey) };
            if (operation === 'refresh') expect(await createArtifact(createInput)).toMatchObject({ ok: true });
            const proof = operation === 'create' ? { method: 'POST', path: '/v1/artifacts', body: content }
                : { method: 'POST', path: `/v1/artifacts/${content.id}`,
                    body: { body: encodePlainArtifactStoredContent({ body: '{"prepared":true}' }), expectedBodyVersion: 1 } };
            const mutationGuard = createDeploymentCandidateArtifactMutationGuard({ binding, effectActionId: root.actionId,
                artifactId: content.id, proof });
            const written = operation === 'create' ? await createArtifact({ ...createInput, mutationGuard })
                : await updateArtifact({ actorUserId: owner.id, artifactId: content.id, mutationGuard,
                    body: { bytes: bytes({ body: '{"prepared":true}' }), expectedVersion: 1 } });
            expect(written).toMatchObject({ ok: true });
            expect(await db.artifactTeamGrant.findUnique({ where: { artifactId_teamId: {
                artifactId: content.id, teamId: team.id,
            } } })).toMatchObject({ accessLevel: 'view' });
            expect(await readArtifactForCaller({ actorAccountId: reader.id, artifactId: content.id }))
                .toMatchObject({ ok: true, artifact: { bodyVersion: operation === 'create' ? 1 : 2 } });
            expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
                accountId: reader.id, kind: 'artifact', entityId: content.id,
            } } })).not.toBeNull();
        } finally { vi.unstubAllEnvs(); }
    });

    it.each([true, false])('rechecks Team recipients at terminal publication (recovery disabled: %s)', async disabled => {
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        if (disabled) process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        else delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '');
        vi.stubEnv('HAPPIER_FEATURE_TEAMS__ENABLED', '1');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const newcomer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: randomUUID() } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const artifact = await plainArtifact(owner.id);
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            createdByAccountId: owner.id, accessLevel: 'view' } });
        const transaction = db.$transaction;
        let advanced = false;
        let checkpoint = -1;
        // Interpose only on the real SQL transport, after the writer has queued
        // its captured recipients. All admission and mutation owners stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, innerReceiver) {
                    if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                    return async (query: string, ...values: unknown[]) => {
                        if (!advanced && query.includes('FROM "Account"') && query.includes('FOR NO KEY UPDATE')) {
                            advanced = true;
                            expect(await inTx(async client => {
                                const result = await admitTeamMemberInTx(client, { teamId: team.id,
                                    accountId: newcomer.id, role: 'member', historyAccess: 'all_existing' });
                                if (result.ok) await publishTeamChangedInTx(client, { teamId: team.id });
                                return result;
                            }))
                                .toMatchObject({ ok: true, outcome: 'added' });
                            // The newly admitted reader can checkpoint the old committed body.
                            expect(await readArtifactForCaller({ actorAccountId: newcomer.id, artifactId: artifact.id }))
                                .toMatchObject({ ok: true, artifact: { bodyVersion: 1 } });
                            checkpoint = (await db.account.findUniqueOrThrow({ where: { id: newcomer.id }, select: { seq: true } })).seq;
                            expect(checkpoint).toBeGreaterThan(0);
                        }
                        return inner.$queryRawUnsafe(query, ...values);
                    };
                },
            })), ...args.slice(1)]);
        } });
        const write = () => updateArtifactHttpMutation(owner.id, artifact.id, {
            body: encodePlainArtifactStoredContent({ status: 'approved' }), expectedBodyVersion: 1,
        });
        try {
            const result = await write();
            expect(advanced).toBe(true);
            if (disabled) {
                // This adapter reports exhausted recovery as a failed request;
                // the contract here is rollback, not a new HTTP error mapping.
                expect(result.statusCode).toBeGreaterThanOrEqual(400);
                expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { bodyVersion: true } }))
                    .toEqual({ bodyVersion: 1 });
                expect((await write()).statusCode).toBe(200);
            } else expect(result.statusCode).toBe(200);
            const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                accountId: newcomer.id, kind: 'artifact', entityId: artifact.id,
            } } });
            expect(change.cursor).toBeGreaterThan(checkpoint);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { bodyVersion: true } }))
                .toEqual({ bodyVersion: 2 });
        } finally {
            db.$transaction = transaction;
            vi.unstubAllEnvs();
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
            await db.artifact.deleteMany({ where: { id: artifact.id } });
            await db.team.delete({ where: { id: team.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, newcomer.id] } } });
        }
    });

    it.each(["update", "revoke"] as const)("orders an existing grant %s before physical Artifact deletion without transaction retries", async operation => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        let releaseWriter!: () => void;
        const writerRelease = new Promise<void>(resolve => { releaseWriter = resolve; });
        let writerReady!: () => void;
        const ready = new Promise<void>(resolve => { writerReady = resolve; });
        let writerPid = 0;
        const writer = inTx(async tx => {
            writerPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
            const input = { artifactId: artifact.id, actorAccountId: owner.id,
                principal: { kind: "account" as const, accountId: recipient.id } };
            const result = operation === "update"
                ? await setArtifactAccessGrantInTx(tx, { ...input, accessLevel: "edit" })
                : await removeArtifactAccessGrantInTx(tx, input);
            writerReady();
            await writerRelease;
            return result;
        }).then(value => ({ value }), error => ({ error }));
        const transaction = db.$transaction;
        const deletionPids: number[] = [];
        const failures: unknown[] = [];
        try {
            await waitForDatabasePause(writer, ready);
            // Only the genuine transaction boundary is wrapped. Retirement,
            // physical deletion, cascades, grant mutation and publication run real SQL.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    deletionPids.push((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid);
                    try { return await callback(tx); } catch (error) { failures.push(error); throw error; }
                }, ...args.slice(1)]);
            } });
            const deletion = deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id });
            let blocked: Array<{ pid: number; blockers: number[]; query: string; wait_event: string | null }> = [];
            await vi.waitFor(async () => {
                blocked = await db.$queryRawUnsafe('SELECT pid, pg_blocking_pids(pid) AS blockers, query, wait_event FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND $2 = ANY(pg_blocking_pids(pid))', deletionPids, writerPid);
                expect(blocked.length).toBe(1);
            }, { timeout: 10_000 });
            console.info("Artifact grant/deletion database boundary", JSON.stringify({ operation, writerPid, blocked, maxRetries: 0 }));
            releaseWriter();
            const [written, removed] = await Promise.all([writer, deletion]);
            console.info("Artifact grant/deletion outcomes", { written, removed, failures });
            expect(written).toMatchObject({ value: { ok: true } });
            expect(removed).toMatchObject({ ok: true });
            expect(await db.artifact.findUnique({ where: { id: artifact.id } })).toBeNull();
        } finally {
            releaseWriter();
            db.$transaction = transaction;
            await writer;
            if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        }
    });

    it("commits an approval update while another Artifact publishes changes on the same Account", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const approval = await plainArtifact(account.id);
        const catalog = await plainArtifact(account.id);
        let peerVersion = 1;
        const failures: Array<{ operation: string; code?: unknown; model?: unknown }> = [];
        const transaction = db.$transaction;
        // Interleave at the real database boundary. Both writers, access checks,
        // storage accounting, revision retention and publication stay real.
        db.$transaction = new Proxy(transaction, {
            apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let approvalRead = false;
                    let advanced = false;
                    const advancePeer = async () => {
                        if (advanced) return;
                        advanced = true;
                        const peer = await updateArtifact({ actorUserId: account.id, artifactId: catalog.id,
                            body: { bytes: bytes({ revision: peerVersion + 1 }), expectedVersion: peerVersion } });
                        expect(peer.ok).toBe(true);
                        peerVersion += 1;
                    };
                    return callback(new Proxy(tx, {
                    get(inner, property, innerReceiver) {
                        if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                            if (approvalRead && query.includes('FROM "Account"') && query.includes("FOR ")) await advancePeer();
                            return inner.$queryRawUnsafe(query, ...values);
                        };
                        if (property !== "artifact") return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.artifact, {
                            get(delegate, method, delegateReceiver) {
                                const operation = Reflect.get(delegate, method, delegateReceiver);
                                if (method === "findFirst") return (...queryArgs: Parameters<typeof tx.artifact.findFirst>) => {
                                    if (queryArgs[0]?.where?.id === approval.id) approvalRead = true;
                                    return Reflect.apply(operation, delegate, queryArgs);
                                };
                                if (method !== "updateMany") return operation;
                                return async (...queryArgs: Parameters<typeof tx.artifact.updateMany>) => {
                                    if (queryArgs[0]?.where?.id === approval.id) await advancePeer();
                                    try { return await Reflect.apply(operation, delegate, queryArgs); }
                                    catch (error) {
                                        const diagnostic = error as { code?: unknown; meta?: { modelName?: unknown } };
                                        failures.push({ operation: "Artifact.updateMany", code: diagnostic.code, model: diagnostic.meta?.modelName });
                                        throw error;
                                    }
                                };
                            },
                        });
                    },
                }));
                }, ...args.slice(1)]);
            },
        });
        try {
            const result = await updateArtifactHttpMutation(account.id, approval.id, {
                body: encodePlainArtifactStoredContent({ status: "approved" }), expectedBodyVersion: 1,
            });
            console.info("ARTIFACT_CONTENTION", JSON.stringify({ peerWrites: peerVersion - 1, failures, statusCode: result.statusCode }));
            expect(result.statusCode).toBe(200);
            expect(peerVersion).toBeGreaterThan(1);
            expect(result.body).toMatchObject({ success: true });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: approval.id }, select: { bodyVersion: true, seq: true } }))
                .toEqual({ bodyVersion: 2, seq: 1 });
        } finally {
            db.$transaction = transaction;
        }
    });

    it("preserves independent header/body versions, head sequence and displaced body under concurrent writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        const outcomes = await Promise.all([
            updateArtifact({ actorUserId: account.id, artifactId: artifact.id,
                header: { bytes: bytes({ kind: "approval_request.v1", decided: true }), expectedVersion: 1 } }),
            updateArtifact({ actorUserId: account.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } }),
        ]);
        expect(outcomes.map(result => result.ok)).toEqual([true, true]);
        expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { headerVersion: true, bodyVersion: true, seq: true } }))
            .toEqual({ headerVersion: 2, bodyVersion: 2, seq: 2 });
        const revisions = await db.artifactRevision.findMany({ where: { artifactId: artifact.id }, select: { bodyVersion: true, body: true } });
        expect(revisions.map(row => row.bodyVersion)).toEqual([1]);
        expect(Buffer.compare(Buffer.from(revisions[0].body), Buffer.from(artifact.body))).toBe(0);
    });

    it("admits one winner for two simultaneous decisions at the same body version", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        const outcomes = await Promise.all(["approved", "canceled"].map(status => updateArtifact({ actorUserId: account.id,
            artifactId: artifact.id, body: { bytes: bytes({ status }), expectedVersion: 1 } })));
        expect(outcomes.filter(result => result.ok)).toHaveLength(1);
        expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["version-mismatch"]);
        expect(await db.artifactRevision.count({ where: { artifactId: artifact.id } })).toBe(1);
    });

    it("admits independent content while an Artifact quota writer holds its Account admission", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", "100000");
        let releaseWriter!: () => void;
        const released = new Promise<void>(resolve => { releaseWriter = resolve; });
        let writerReady!: () => void;
        const ready = new Promise<void>(resolve => { writerReady = resolve; });
        let writerPid = 0;
        let contentPid = 0;
        let contentAdmitted = false;
        const writer = inTx(async tx => {
            writerPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
            return updateArtifactTx(new Proxy(tx, { get(inner, property, receiver) {
                if (property !== "artifact") return Reflect.get(inner, property, receiver);
                return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "updateMany") return operation;
                    return async (...args: Parameters<typeof tx.artifact.updateMany>) => {
                        writerReady();
                        await released;
                        return Reflect.apply(operation, delegate, args);
                    };
                } });
            } }), { actorUserId: account.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } });
        });
        let content: Promise<void> | undefined;
        try {
            await waitForDatabasePause(writer, ready);
            content = inTx(async tx => {
                contentPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "content");
                contentAdmitted = true;
            });
            await vi.waitFor(async () => {
                const blocked = contentPid === 0 ? [] : await db.$queryRawUnsafe<Array<{ pid: number }>>(
                    'SELECT pid FROM pg_stat_activity WHERE pid = $1 AND $2 = ANY(pg_blocking_pids(pid))', contentPid, writerPid);
                expect(contentAdmitted || blocked.length === 1).toBe(true);
            }, { timeout: 10_000 });
            const admittedBeforeQuotaWriterCompleted = contentAdmitted;
            releaseWriter();
            expect(await writer).toMatchObject({ ok: true });
            await content;
            expect(admittedBeforeQuotaWriterCompleted).toBe(true);
        } finally {
            releaseWriter();
            await Promise.allSettled([writer, ...(content ? [content] : [])]);
            vi.unstubAllEnvs();
        }
    });

    it("keeps Account quota admission atomic across concurrent Artifact creates", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const header = bytes({ kind: "document" });
        const body = bytes({ value: "content" });
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", String(header.byteLength + body.byteLength));
        let releaseWriters!: () => void;
        const released = new Promise<void>(resolve => { releaseWriters = resolve; });
        let firstReady!: () => void;
        const ready = new Promise<void>(resolve => { firstReady = resolve; });
        let firstPid = 0;
        let secondPid = 0;
        let secondReachedInsert = false;
        const create = (first: boolean) => inTx(async tx => {
            const pid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
            if (first) firstPid = pid;
            else secondPid = pid;
            return createArtifactTx(new Proxy(tx, { get(inner, property, receiver) {
                if (property !== "artifact") return Reflect.get(inner, property, receiver);
                return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "create") return operation;
                    return async (...args: Parameters<typeof tx.artifact.create>) => {
                        if (first) firstReady();
                        else secondReachedInsert = true;
                        await released;
                        return Reflect.apply(operation, delegate, args);
                    };
                } });
            } }), { actorUserId: account.id, artifactId: randomUUID(), header, body,
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        });
        const first = create(true);
        let second: ReturnType<typeof create> | undefined;
        try {
            await waitForDatabasePause(first, ready);
            second = create(false);
            // KEY SHARE is deliberately insufficient: it lets both real budget
            // reads finish before either insert, admitting two full-size docs.
            await vi.waitFor(async () => {
                const blocked = secondPid === 0 ? [] : await db.$queryRawUnsafe<Array<{ pid: number }>>(
                    'SELECT pid FROM pg_stat_activity WHERE pid = $1 AND $2 = ANY(pg_blocking_pids(pid))', secondPid, firstPid);
                expect(secondReachedInsert || blocked.length === 1).toBe(true);
            }, { timeout: 10_000 });
            releaseWriters();
            const outcomes = await Promise.all([first, second]);
            expect(outcomes.filter(result => result.ok)).toHaveLength(1);
            expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["quota_exceeded"]);
            expect((await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes).toBe(header.byteLength + body.byteLength);
        } finally {
            releaseWriters();
            await Promise.allSettled([first, ...(second ? [second] : [])]);
            vi.unstubAllEnvs();
        }
    });

    it("orders a quota-configured grant before an Artifact update without a terminal Account inversion", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", "100000");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        let releaseGrant!: () => void;
        const released = new Promise<void>(resolve => { releaseGrant = resolve; });
        let grantReady!: () => void;
        const ready = new Promise<void>(resolve => { grantReady = resolve; });
        let grantPid = 0;
        let updatePid = 0;
        const grant = inTx(async tx => {
            grantPid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
            return setArtifactAccessGrantInTx(new Proxy(tx, { get(inner, property, receiver) {
                if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, receiver);
                return async (query: string, ...values: unknown[]) => {
                    const result = await inner.$queryRawUnsafe(query, ...values);
                    if (query.includes('FROM "Artifact"') && query.includes("FOR ")) {
                        grantReady();
                        await released;
                    }
                    return result;
                };
            } }), { actorAccountId: owner.id, artifactId: artifact.id,
                principal: { kind: "account", accountId: recipient.id }, accessLevel: "edit" });
        }).then(value => ({ value }), error => ({ error }));
        let update: Promise<{ value: Awaited<ReturnType<typeof updateArtifactTx>> } | { error: unknown }> | undefined;
        try {
            await waitForDatabasePause(grant, ready);
            update = inTx(async tx => {
                updatePid = (await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0].pid;
                return updateArtifactTx(tx, { actorUserId: owner.id, artifactId: artifact.id,
                    body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } });
            }).then(value => ({ value }), error => ({ error }));
            await vi.waitFor(async () => {
                const blocked = updatePid === 0 ? [] : await db.$queryRawUnsafe<Array<{ pid: number }>>(
                    'SELECT pid FROM pg_stat_activity WHERE pid = $1 AND $2 = ANY(pg_blocking_pids(pid))', updatePid, grantPid);
                expect(blocked).toHaveLength(1);
            }, { timeout: 10_000 });
            releaseGrant();
            const outcomes = await Promise.all([grant, update]);
            expect(outcomes).toMatchObject([{ value: { ok: true } }, { value: { ok: true } }]);
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).bodyVersion).toBe(2);
            expect((await db.artifactAccountGrant.findUniqueOrThrow({ where: { artifactId_accountId: {
                artifactId: artifact.id, accountId: recipient.id } } })).accessLevel).toBe("edit");
        } finally {
            releaseGrant();
            await Promise.allSettled([grant, ...(update ? [update] : [])]);
            vi.unstubAllEnvs();
        }
    });

    it("replays an overlapping create of the same Artifact without another write or cursor", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const input = { actorUserId: account.id, artifactId: randomUUID(), header: bytes({ kind: "document" }),
            body: bytes({ value: "content" }), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) };
        let firstReady!: () => void;
        const ready = new Promise<void>(resolve => { firstReady = resolve; });
        let secondReady!: () => void;
        const competing = new Promise<void>(resolve => { secondReady = resolve; });
        let releaseFirst!: () => void;
        const released = new Promise<void>(resolve => { releaseFirst = resolve; });
        let releaseSecond!: () => void;
        const secondReleased = new Promise<void>(resolve => { releaseSecond = resolve; });
        const transaction = db.$transaction;
        let attempts = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            const first = attempts++ === 0;
            return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "artifact") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "create") return operation;
                    return async (...queryArgs: Parameters<typeof tx.artifact.create>) => {
                        if (first) { firstReady(); await released; }
                        else { secondReady(); await secondReleased; }
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            const first = createArtifact(input);
            await waitForDatabasePause(first, ready);
            const second = createArtifact(input);
            await waitForDatabasePause(second, competing);
            releaseFirst();
            const created = await first;
            releaseSecond();
            const replay = await second;
            expect(created).toMatchObject({ ok: true, didWrite: true });
            expect(replay).toMatchObject({ ok: true, didWrite: false });
            if (!created.ok || !replay.ok) throw new Error("Expected an idempotent create replay");
            expect(replay.artifact).toEqual(created.artifact);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(1);
        } finally { releaseFirst(); releaseSecond(); db.$transaction = transaction; }
    });

    it("keeps retained-body quota admission atomic across concurrent Artifact updates", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifacts = await Promise.all([plainArtifact(account.id), plainArtifact(account.id)]);
        const baseline = (await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes;
        const body = bytes({ value: "replacement content" });
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", String(baseline + body.byteLength));
        try {
            const outcomes = await Promise.all(artifacts.map(artifact => updateArtifact({ actorUserId: account.id,
                artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 } })));
            expect(outcomes.filter(result => result.ok)).toHaveLength(1);
            expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["quota_exceeded"]);
            expect((await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes).toBe(baseline + body.byteLength);
        } finally { vi.unstubAllEnvs(); }
    });

    it("checks the complete document budget when independent header and body writes overlap", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        const header = bytes({ kind: "document", title: "a larger header" });
        const body = bytes({ value: "replacement content" });
        const baseline = artifact.header.byteLength + artifact.body.byteLength;
        const limit = baseline + Math.max(header.byteLength - artifact.header.byteLength, body.byteLength);
        vi.stubEnv("HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES", String(limit));
        let firstReady!: () => void;
        const ready = new Promise<void>(resolve => { firstReady = resolve; });
        let releaseFirst!: () => void;
        const released = new Promise<void>(resolve => { releaseFirst = resolve; });
        let secondReady!: () => void;
        const competing = new Promise<void>(resolve => { secondReady = resolve; });
        // Pause the first writer after its real budget projection. The peer
        // either reaches the same projection or waits at the resource lock.
        const instrument = (tx: Tx, first: boolean) => new Proxy(tx, { get(inner, property, receiver) {
            if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                if (!first && query.includes('FROM "Artifact"') && query.includes("FOR ")) secondReady();
                return inner.$queryRawUnsafe(query, ...values);
            };
            if (property !== "artifact") return Reflect.get(inner, property, receiver);
            return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                const operation = Reflect.get(delegate, method, delegateReceiver);
                if (method !== "updateMany") return operation;
                return async (...args: Parameters<typeof tx.artifact.updateMany>) => {
                    if (first) { firstReady(); await released; }
                    else secondReady();
                    return Reflect.apply(operation, delegate, args);
                };
            } });
        } });
        try {
            const first = inTx(tx => updateArtifactTx(instrument(tx, true), { actorUserId: account.id,
                artifactId: artifact.id, header: { bytes: header, expectedVersion: 1 } }));
            await waitForDatabasePause(first, ready);
            const second = inTx(tx => updateArtifactTx(instrument(tx, false), { actorUserId: account.id,
                artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 } }));
            await waitForDatabasePause(second, competing);
            releaseFirst();
            const outcomes = await Promise.all([first, second]);
            expect(outcomes.filter(result => result.ok)).toHaveLength(1);
            expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["quota_exceeded"]);
            expect((await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes).toBeLessThanOrEqual(limit);
        } finally { releaseFirst(); vi.unstubAllEnvs(); }
    });

    it("replays an expanded audience before publishing to a newly granted recipient", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        await makeShareEligibleForTest(owner.id, recipient.id);
        const artifact = await plainArtifact(owner.id);
        const restore = beforeArtifactAccountLock(artifact.id, async () => {
            expect((await inTx(tx => setArtifactAccessGrantInTx(tx, { artifactId: artifact.id, actorAccountId: owner.id,
                principal: { kind: "account", accountId: recipient.id }, accessLevel: "view" }), { isolationLevel: "Serializable" })).ok).toBe(true);
        });
        try {
            const result = await updateArtifact({ actorUserId: owner.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("Expected expanded-audience write to commit");
            expect(result.recipientUpdates.map(row => row.accountId).sort()).toEqual([owner.id, recipient.id].sort());
        } finally { restore(); }
    });

    it("rejects an editor downgraded while its publication locks are being acquired", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const editor = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: editor.id,
            accessLevel: "edit", createdByAccountId: owner.id } });
        const restore = beforeArtifactAccountLock(artifact.id, async () => {
            expect((await inTx(tx => setArtifactAccessGrantInTx(tx, { artifactId: artifact.id, actorAccountId: owner.id,
                principal: { kind: "account", accountId: editor.id }, accessLevel: "view" }), { isolationLevel: "Serializable" })).ok).toBe(true);
        });
        try {
            expect(await updateArtifact({ actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } })).toMatchObject({ ok: false, error: "not-found" });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { bodyVersion: true } })).bodyVersion).toBe(1);
        } finally { restore(); }
    });

    it("posts a quoted Artifact Discussion with quota admission and transaction recovery disabled", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifactId = randomUUID();
        expect(await createArtifact({ actorUserId: owner.id, artifactId, header: bytes({ title: "Doc", kind: "markdown" }),
            body: bytes({ body: "Hello" }), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) }))
            .toMatchObject({ ok: true });
        const authentication = createPresentUserSessionAccessAuthentication();
        const doc = { ref: { kind: "doc" as const, artifactId, serverId: "home" },
            revision: { headerVersion: 1, bodyVersion: 1 } };
        const passage = { ...doc, range: { start: 0, end: 5 }, quote: "Hello" };
        const content = { kind: "doc_passage_comment" as const, passage,
            content: { v: 1 as const, parts: [{ t: "text" as const, text: "Review this passage" }] } };
        const request = buildDiscussionMutationRequestBodyV1({ kind: "create", creationLocalId: randomUUID(),
            titleContent: { t: "plain", v: { v: 1, title: "Comments" } }, firstMessage: { localId: randomUUID(),
                content: { t: "plain", v: content }, authoredContent: content, mentionedAccountIds: [],
                replyTarget: { kind: "doc_passage", doc } } });
        const discussion = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        if (!discussion.ok) throw new Error(discussion.error);
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", "100000");
        vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
        try {
            const posted = await postDiscussionMessage({ actorAccountId: owner.id, authentication,
                discussionId: discussion.value.discussion.id,
                request: buildDiscussionMutationRequestBodyV1({ kind: "post", localId: randomUUID(),
                    content: { t: "plain", v: content }, authoredContent: content, mentionedAccountIds: [],
                    replyTarget: { kind: "doc_passage", doc } }) });
            expect(posted).toMatchObject({ ok: true });
            expect(await db.discussionMessage.count({ where: { discussionId: discussion.value.discussion.id } })).toBe(2);
        } finally { vi.unstubAllEnvs(); }
    });

    it("admits the complete cross-owner proposal audience before locking either resource", async () => {
        const suffix = randomUUID();
        const owner = await db.account.create({ data: { id: `a-artifact-${suffix}`, encryptionMode: "plain" } });
        const author = await db.account.create({ data: { id: `z-discussion-${suffix}`, encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { id: `0-discussion-viewer-${suffix}`, encryptionMode: "plain" } });
        const artifactId = randomUUID();
        expect(await createArtifact({ actorUserId: owner.id, artifactId, header: bytes({ title: "Doc" }),
            body: bytes({ body: "Hello" }), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
        await db.artifactAccountGrant.create({ data: { artifactId, accountId: author.id, accessLevel: "edit", createdByAccountId: owner.id } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const ref = { kind: "doc" as const, artifactId, serverId: "home" };
        const revision = { headerVersion: 1, bodyVersion: 1 };
        const content = { kind: "doc_edit_proposal" as const, proposal: {
            target: { ref, revision, range: { start: 0, end: 5 }, quote: "Hello" },
            baseRevision: revision, before: "Hello", after: "World", reason: "Replacement",
        } };
        const request = buildDiscussionMutationRequestBodyV1({ kind: "create", creationLocalId: randomUUID(),
            titleContent: { t: "plain", v: { v: 1, title: "Proposal" } }, firstMessage: { localId: randomUUID(),
                content: { t: "plain", v: content }, authoredContent: content, mentionedAccountIds: [],
                replyTarget: { kind: "doc_passage", doc: { ref, revision } } } });
        const discussion = await createDiscussion({ actorAccountId: author.id, authentication, request });
        if (!discussion.ok) throw new Error(discussion.error);
        await db.discussionAccountGrant.create({ data: { discussionId: discussion.value.discussion.id, accountId: viewer.id,
            accessLevel: "view", createdByAccountId: author.id } });
        const proposalRef = createDiscussionMessageRefV1({ serverId: "home", discussionId: discussion.value.discussion.id }, discussion.value.firstMessage);
        const admitted = new Set<string>();
        const lateAdmissions: string[] = [];
        let resourceLocked = false;
        const result = await inTx(tx => decideArtifactEditProposalInTx(new Proxy(tx, { get(inner, property, receiver) {
            if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, receiver);
            return async (query: string, ...values: unknown[]) => {
                if (query.includes('FROM "Account"') && query.includes("FOR ")) {
                    const ids = values.flatMap(value => typeof value === "string" ? [value]
                        : Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
                    for (const id of ids) {
                        if (resourceLocked && !admitted.has(id)) lateAdmissions.push(id);
                        admitted.add(id);
                    }
                }
                const result = await inner.$queryRawUnsafe(query, ...values);
                if ((query.includes('FROM "Artifact"') || query.includes('FROM "DiscussionMessage"')) && query.includes("FOR ")) resourceLocked = true;
                return result;
            };
        } }), { actorAccountId: author.id, authentication, proposalRef, decision: "accept", expectedRevision: revision }));
        expect(result).toMatchObject({ ok: true, disposition: { state: "accepted" } });
        expect(lateAdmissions).toEqual([]);
        expect(admitted.has(owner.id)).toBe(true);
        expect(admitted.has(viewer.id)).toBe(true);
        expect((await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })).bodyVersion).toBe(2);
    });
});
