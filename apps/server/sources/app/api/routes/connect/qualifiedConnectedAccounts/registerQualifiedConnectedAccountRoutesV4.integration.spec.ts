import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import {
    QualifiedConnectedAccountGroupMemberDeleteV4Schema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
    QualifiedConnectedServiceUsageSourceV4Schema,
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    type QualifiedConnectedAccountGroupV4,
} from "@happier-dev/protocol";
import { buildProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { sealProviderAccountUsagePageProjectionV1 } from '@happier-dev/protocol/connect/providerAccountUsagePageProjectionCrypto';
import { readProviderAccountUsageHistory } from '../providerAccountUsage/recordStorage';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { QualifiedConnectedAccountGroupResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';

import { db } from "@/storage/db";
import { prismaRuntime } from "@/storage/prisma";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createLightSqliteHarness,
    createAccountTokenForTests,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    withAuthenticatedTestApp,
} from "@/app/api/testkit/sqliteFastify";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    upsertProviderAccountUsageRecord,
} from "../providerAccountUsage";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./registerQualifiedConnectedAccountCredentialRoutesV4";
import { mutateQualifiedConnectedServiceCredential } from './credentialRepository';
import { inReadSnapshot } from '@/storage/inTx';
import { buildAccountConnectedServicesProjection } from '../../account/connectedServicesProjection';

const service = {
    pluginId: "example.connected-accounts",
    localId: "novel-service",
} as const;
const ref = {
    service,
    accountId: "provider/account",
} as const;
const groupRef = {
    service,
    groupId: "primary",
} as const;
const source = {
    ref,
    bindingKind: "account",
} as const;

function createPoolActionExecutor(host: ConnectedServiceConfigurationActionHostV1) {
    // Server tests keep their fixture inside rootDir. Only the HTTP boundary
    // is admitted; every unrelated host port fails loudly.
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected pool Action host boundary'); };
    return createActionExecutor({
        executionRunStart: unexpected, executionRunList: unexpected, executionRunGet: unexpected,
        detachedExecutionRunSend: unexpected, executionRunStop: unexpected, executionRunAction: unexpected,
        executionRunWait: unexpected, sessionOpen: unexpected, sessionFork: unexpected, sessionRollback: unexpected,
        sessionSpawnNew: unexpected, pathsListRecent: unexpected, machinesList: unexpected, serversList: unexpected,
        reviewEnginesList: unexpected, agentsBackendsList: unexpected, agentsModelsList: unexpected,
        sessionSendMessage: unexpected, sessionModeSet: unexpected, sessionModesList: unexpected,
        sessionList: unexpected, sessionActivityGet: unexpected, sessionRecentMessagesGet: unexpected,
        resetGlobalVoiceAgent: unexpected, daemonMemorySearch: unexpected, daemonMemoryGetWindow: unexpected,
        daemonMemoryEnsureUpToDate: unexpected,
        connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input),
    });
}

describe("qualified Connected Account V4 route family (integration)", () => {
    let harness: LightSqliteHarness;

    it("masks disabled automatic quota spending without losing the saved pool choice", async () => {
        const account = await db.account.create({ data: { publicKey: "quota-reset-policy" }, select: { id: true } });
        const headers = { "x-test-user-id": account.id };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async (app) => {
            const created = await app.inject({ method: "POST", url: "/v4/connect/qualified/groups", headers, payload: {
                service, group: { groupId: "quota-reset", policy: {
                    autoUseQuotaResetsWhenExhausted: true,
                    autoDisablePlanInvalidAccounts: true,
                    quotaLimitSelection: { mode: "selected", providerLimitIds: ["weekly"] },
                } },
            } });
            expect(created.statusCode, created.body).toBe(200);
            expect(created.json().group.policy.autoUseQuotaResetsWhenExhausted).toBe(true);
            expect(created.json().group.policy.strategy).toBe("expiry_first");
            expect(created.json().group.policy.autoDisablePlanInvalidAccounts).toBe(true);
            expect(created.json().group.policy.quotaLimitSelection).toEqual({ mode: "selected", providerLimitIds: ["weekly"] });
            const url = "/v4/connect/qualified/groups?service=" + encodeURIComponent(
                encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, service),
            );
            process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "0";
            const disabled = await app.inject({ method: "GET", url, headers });
            expect(disabled.statusCode, disabled.body).toBe(200);
            expect(disabled.json().groups[0].policy).not.toHaveProperty("autoUseQuotaResetsWhenExhausted");
            expect(disabled.json().groups[0].policy).not.toHaveProperty("quotaLimitSelection");
            expect(disabled.json().groups[0].policy.strategy).toBe("expiry_first");
            const disabledGroup = disabled.json().groups[0];
            const disabledProfile = await inReadSnapshot(tx => buildAccountConnectedServicesProjection({
                tx, accountId: account.id, includeGroups: true, env: process.env,
            }));
            expect(disabledProfile.connectedAccountGroupsV4).toMatchObject([disabledGroup]);
            expect(disabledProfile.connectedAccountGroupsV4[0]?.policy).toEqual(disabledGroup.policy);
            const rejectedOptIn = await app.inject({ method: "PATCH", url: "/v4/connect/qualified/group", headers, payload: {
                service, groupId: "quota-reset",
                expectedGeneration: disabledGroup.generation,
                expectedIncarnation: disabledGroup.incarnation,
                policy: { ...disabledGroup.policy, autoUseQuotaResetsWhenExhausted: true },
            } });
            expect(rejectedOptIn.statusCode, rejectedOptIn.body).toBe(400);
            const rejectedLimitSelection = await app.inject({ method: "PATCH", url: "/v4/connect/qualified/group", headers, payload: {
                service, groupId: "quota-reset",
                expectedGeneration: disabledGroup.generation,
                expectedIncarnation: disabledGroup.incarnation,
                policy: { ...disabledGroup.policy, quotaLimitSelection: { mode: "selected", providerLimitIds: ["weekly"] } },
            } });
            expect(rejectedLimitSelection.statusCode, rejectedLimitSelection.body).toBe(400);
            const edited = await app.inject({ method: "PATCH", url: "/v4/connect/qualified/group", headers, payload: {
                service, groupId: "quota-reset",
                expectedGeneration: disabledGroup.generation,
                expectedIncarnation: disabledGroup.incarnation,
                policy: { ...disabledGroup.policy, cooldownMs: 45_000 },
            } });
            expect(edited.statusCode, edited.body).toBe(200);
            expect(edited.json().group.policy).not.toHaveProperty("autoUseQuotaResetsWhenExhausted");
            expect(edited.json().group.policy).not.toHaveProperty("quotaLimitSelection");
            process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED = "1";
            const restored = await app.inject({ method: "GET", url, headers });
            expect(restored.json().groups[0].policy.autoUseQuotaResetsWhenExhausted).toBe(true);
            expect(restored.json().groups[0].policy.quotaLimitSelection).toEqual({ mode: "selected", providerLimitIds: ["weekly"] });
            expect(restored.json().groups[0].policy.cooldownMs).toBe(45_000);
            const restoredProfile = await inReadSnapshot(tx => buildAccountConnectedServicesProjection({
                tx, accountId: account.id, includeGroups: true, env: process.env,
            }));
            expect(restoredProfile.connectedAccountGroupsV4).toMatchObject(restored.json().groups);
            expect(restoredProfile.connectedAccountGroupsV4[0]?.policy).toEqual(restored.json().groups[0].policy);
            process.env.HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED = "0";
            const fallbackDisabled = await app.inject({ method: "GET", url, headers });
            expect(fallbackDisabled.json().groups[0].policy).not.toHaveProperty("autoDisablePlanInvalidAccounts");
            const fallbackDisabledProfile = await inReadSnapshot(tx => buildAccountConnectedServicesProjection({
                tx, accountId: account.id, includeGroups: true, env: process.env,
            }));
            expect(fallbackDisabledProfile.connectedAccountGroupsV4).toMatchObject(fallbackDisabled.json().groups);
            expect(fallbackDisabledProfile.connectedAccountGroupsV4[0]?.policy).toEqual(fallbackDisabled.json().groups[0].policy);
            const rejectedAutoDisable = await app.inject({ method: "PATCH", url: "/v4/connect/qualified/group", headers, payload: {
                service, groupId: "quota-reset",
                expectedGeneration: fallbackDisabled.json().groups[0].generation,
                expectedIncarnation: fallbackDisabled.json().groups[0].incarnation,
                policy: { ...fallbackDisabled.json().groups[0].policy, autoDisablePlanInvalidAccounts: true },
            } });
            expect(rejectedAutoDisable.statusCode, rejectedAutoDisable.body).toBe(400);
        });
    });

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-connected-account-v4-routes-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS usage_idle_credential_write');
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS usage_idle_account_write');
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroupMember.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroup.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it('refuses a requester guest bearer the custodian credential without disclosing its content', async () => {
        const custodian = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const requester = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const written = await mutateQualifiedConnectedServiceCredential({ accountId: custodian.id, ref,
            authenticationModeId: 'oauth', expectedCredentialRevision: null,
            content: { t: 'encrypted', c: 'disposable-custodian-envelope' }, metadata: { displayName: 'Custodian fixture', scopes: [] } });
        expect(written.status).toBe('written');
        const guestBearer = await createAccountTokenForTests(requester.id, { kind: 'terminal', authority: 'account_automation' });
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const response = await app.inject({ method: 'GET', url: '/v4/connect/qualified/credential?ref=' + encodeURIComponent(
                encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountRefSchema, ref)),
                headers: { authorization: `Bearer ${guestBearer}` } });
            expect(response.statusCode, response.body).toBe(404);
            expect(response.json()).toEqual({ error: 'connect_credential_not_found' });
            expect(response.body).not.toContain('disposable-custodian-envelope');
            expect(response.body).not.toContain('Custodian fixture');
        }, { authentication: 'real' });
        expect(await db.serviceAccountToken.count({ where: { accountId: custodian.id } })).toBe(1);
    });

    it('admits mode-protected page projections only for complete accepted coverage and preserves exact history', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const stranger = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        const first = createUsageSnapshot({ fetchedAt: Date.now() - 3000, recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: 'projection-account' }) });
        const route = '/v4/connect/qualified/provider-account-usage/history';
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                ref, authenticationModeId: 'api-key', expectedCredentialRevision: null, content: { t: 'plain', v: { token: 'test' } },
                metadata: { scopes: [], providerIdentity: { accountId: 'projection-account' } },
            } });
            expect(credential.statusCode, credential.body).toBe(200);
            const write = async (snapshot: typeof first) => {
                const result = await app.inject({ method: 'POST', url: '/v4/connect/qualified/provider-account-usage', headers, payload: {
                    source, expectedCredentialRevision: credential.json().credentialRevision, expectedConfigurationRevision: null, recordId: first.recordId, recordKey: first.recordKey,
                    payloadMode: 'plain_json_v1', status: 'ok', snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs,
                } });
                expect(result.statusCode, result.body).toBe(200);
            };
            await write(first);
            // Credentials remain physically untouched on idle observations.
            // Account encryption admission uses a no-op settingsVersion fence
            // (3c8b82b6e1); forbid publication writes without rejecting that lock.
            await db.$executeRawUnsafe(`CREATE TRIGGER usage_idle_credential_write BEFORE UPDATE ON ServiceAccountToken
                BEGIN SELECT RAISE(ABORT, 'unchanged_usage_updated_credential'); END`);
            await db.$executeRawUnsafe(`CREATE TRIGGER usage_idle_account_write BEFORE UPDATE OF seq ON Account
                BEGIN SELECT RAISE(ABORT, 'derived_usage_updated_account'); END`);
            const sourceTimestamp = new Date(1);
            await db.connectedServiceUsageSource.updateMany({ where: { accountId: account.id }, data: { updatedAt: sourceTimestamp } });
            const beforeIdle = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            for (let index = 0; index < 10; index++) await write(first);
            expect((await db.connectedServiceUsageSource.findFirstOrThrow({ where: { accountId: account.id } })).updatedAt).toEqual(sourceTimestamp);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(beforeIdle);
            const range = { startAtMs: first.fetchedAtMs, endAtMs: first.fetchedAtMs + 1000 };
            const demand = { range, resolution: 'accepted_observations' as const };
            const read = (projection = demand, readHeaders: Record<string, string> = headers) => app.inject({ method: 'GET', url: route + '?query=' + encodeURIComponent(JSON.stringify({ recordId: first.recordId, projection })), headers: readHeaders });
            const missing = await read();
            expect(missing.statusCode, missing.body).toBe(200);
            expect(missing.json()).toEqual({ projection: null, complete: false });
            const history = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId, history: { range, pageSize: 100 } });
            const witness = history.entries[0]!;
            const projection = { recordId: first.recordId, encoding: 'meter_readings_runs_v1', demand, observationCount: 1,
                frontier: { id: witness.id, observedAtMs: witness.observedAtMs },
                content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                    recordId: first.recordId, range, history: { entries: [{ id: witness.id, observedAtMs: witness.observedAtMs, snapshot: first }], nextCursor: null },
                }) }) };
            const put = (payload: unknown = projection, putHeaders: Record<string, string> = headers) => app.inject({ method: 'PUT', url: route, headers: putHeaders, payload });
            expect((await put(projection, {})).statusCode).toBe(401);
            expect((await put(projection, { 'x-test-user-id': stranger.id })).statusCode).toBe(404);
            const invalidCount = await put({ ...projection, observationCount: 0, frontier: null,
                content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                    recordId: first.recordId, range, history: { entries: [], nextCursor: null },
                }) }) });
            expect(invalidCount.statusCode, invalidCount.body).toBe(409);
            expect(invalidCount.json()).toEqual({ error: 'provider_account_usage_projection_conflict' });
            const invalidFrontier = await put({ ...projection, frontier: { ...projection.frontier, id: 'absent' },
                content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                    recordId: first.recordId, range, history: { entries: [{ id: 'absent', observedAtMs: witness.observedAtMs, snapshot: first }], nextCursor: null },
                }) }) });
            expect(invalidFrontier.statusCode).toBe(409);
            const modeMismatch = await put({ ...projection, content: { t: 'encrypted', c: 'opaque' } });
            expect(modeMismatch.statusCode).toBe(409);
            expect(modeMismatch.json()).toEqual({ error: 'provider_account_usage_storage_mode_mismatch' });
            const written = await put();
            expect(written.statusCode, written.body).toBe(200);
            expect(written.json()).toEqual({ success: true });
            const documentUrl = route + '?query=' + encodeURIComponent(JSON.stringify({ recordId: first.recordId, projection: demand }));
            const heldDocument = await app.inject({ method: 'GET', url: documentUrl, headers });
            expect(heldDocument.statusCode, heldDocument.body).toBe(200);
            expect(heldDocument.json().projection).toEqual(projection);
            expect(written.headers.etag).toBeDefined();
            expect(written.headers.etag).not.toBe(heldDocument.headers.etag); // PUT acknowledges a protected prefix, GET includes coverage.
            for (let index = 0; index < 5; index++) {
                const moving = { ...demand, range: { ...range, endAtMs: range.endAtMs + index } };
                const head = await read(moving, { ...headers, 'if-none-match': String(heldDocument.headers.etag) });
                expect(head.statusCode).toBe(304);
                expect(head.body).toBe('');
                expect(head.headers['x-happier-usage-projection-complete']).toBe('true');
                expect(head.headers['access-control-expose-headers']).toContain('x-happier-usage-projection-complete');
                expect(head.headers.etag).toBe(heldDocument.headers.etag);
                expect(String(head.headers['access-control-expose-headers']).toLowerCase()).toContain('etag');
                const unchanged = await app.inject({ method: 'GET', url: documentUrl,
                    headers: { ...headers, 'if-none-match': String(heldDocument.headers.etag) } });
                expect(unchanged.statusCode, unchanged.body).toBe(304);
                expect(unchanged.body).toBe('');
            }
            const held = heldDocument;
            const revision = held.headers.etag;
            for (let index = 0; index < 5; index++) {
                const unchanged = await app.inject({ method: 'GET', url: documentUrl, headers: { ...headers, 'if-none-match': String(revision) } });
                expect(unchanged.statusCode, unchanged.body).toBe(304);
                expect(Buffer.byteLength(unchanged.body)).toBe(0);
            }
            expect(held.headers['cache-control']).toBe('private, no-cache');
            expect(String(held.headers['access-control-expose-headers']).toLowerCase()).toContain('etag');
            expect(held.headers.vary).toContain('Authorization');
            expect(typeof revision).toBe('string');
            // Revalidation never bypasses the qualified source or Account admission.
            expect((await app.inject({ method: 'GET', url: documentUrl, headers: { 'x-test-user-id': stranger.id,
                'if-none-match': String(revision) } })).statusCode).toBe(404);
            // A derived document never advances Account changes. Repeated
            // publication by two tabs also leaves the current record untouched.
            const projectionTimestamp = new Date(2);
            await db.providerAccountUsageRecord.updateMany({ where: { accountId: account.id }, data: { updatedAt: projectionTimestamp } });
            const afterProjection = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            expect(afterProjection).toEqual(beforeIdle);
            for (let index = 0; index < 10; index++) expect((await put()).statusCode).toBe(200);
            expect((await db.providerAccountUsageRecord.findFirstOrThrow({ where: { accountId: account.id } })).updatedAt).toEqual(projectionTimestamp);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(afterProjection);
            const widerDemand = { ...demand, range: { ...range, endAtMs: range.endAtMs + 5000 } };
            expect((await read(widerDemand)).json()).toEqual({ projection, complete: true });
            expect((await read({ ...demand, range: { startAtMs: range.startAtMs - 1, endAtMs: range.endAtMs } })).json())
                .toEqual({ projection: null, complete: false });
            await db.$executeRawUnsafe('DROP TRIGGER usage_idle_credential_write');
            await db.$executeRawUnsafe('DROP TRIGGER usage_idle_account_write');
            // The new clock publishes the global history hint and its exact-record companion.
            await write({ ...first, planLabel: 'new plan', fetchedAtMs: first.fetchedAtMs + 2000, observedAtMs: first.observedAtMs + 2000 });
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq).toBe(beforeIdle.seq + 2);
            expect((await read(widerDemand)).json()).toEqual({ projection, complete: false });
            expect((await read()).json()).toEqual({ projection, complete: true });
            const incompleteHead = await read(widerDemand, { ...headers, 'if-none-match': String(revision) });
            expect(incompleteHead.statusCode).toBe(200);
            expect(incompleteHead.headers.etag).not.toBe(revision);
            expect(incompleteHead.json()).toEqual({ projection, complete: false });
            expect(incompleteHead.headers['x-happier-usage-projection-complete']).toBe('false');
            const tailRead = await app.inject({ method: 'GET', url: documentUrl, headers });
            const tailRevision = tailRead.headers.etag;
            const extendedHistory = await readProviderAccountUsageHistory({ accountId: account.id, recordId: first.recordId,
                history: { range: widerDemand.range, pageSize: 100 } });
            const extension = extendedHistory.entries.map(entry => ({ id: entry.id, observedAtMs: entry.observedAtMs,
                snapshot: entry.record.snapshot! }));
            const lastExtension = extension.at(-1)!;
            const otherTab = await put({ ...projection, demand: widerDemand, observationCount: extension.length,
                frontier: { id: lastExtension.id, observedAtMs: lastExtension.observedAtMs },
                content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain', projection: buildProviderAccountUsagePageProjectionV1({
                    recordId: first.recordId, range: widerDemand.range, history: { entries: extension, nextCursor: null },
                }) }) });
            expect(otherTab.statusCode, otherTab.body).toBe(200);
            const changed = await app.inject({ method: 'GET', url: documentUrl, headers: { ...headers, 'if-none-match': String(tailRevision) } });
            expect(changed.statusCode, changed.body).toBe(200);
            expect(changed.json().projection.observationCount).toBe(2);
            expect(otherTab.headers.etag).toBeDefined();
            expect(otherTab.headers.etag).not.toBe(changed.headers.etag);
            // A narrower valid submission can reuse an already-stored wider
            // document. It must not bind that winner's ETag to its smaller body.
            const retainedWider = await put();
            expect(retainedWider.statusCode, retainedWider.body).toBe(200);
            expect(retainedWider.headers.etag).toBeUndefined();
            const acknowledged = await app.inject({ method: 'GET', url: documentUrl, headers: { ...headers, 'if-none-match': String(changed.headers.etag) } });
            expect(acknowledged.statusCode, acknowledged.body).toBe(304);
            expect(acknowledged.body).toBe('');
            const stale = await put({ ...projection, demand: widerDemand, content: sealProviderAccountUsagePageProjectionV1({ accountMode: 'plain',
                projection: buildProviderAccountUsagePageProjectionV1({ recordId: first.recordId, range: widerDemand.range,
                    history: { entries: [{ id: witness.id, observedAtMs: witness.observedAtMs, snapshot: first }], nextCursor: null } }) }) });
            expect(stale.statusCode).toBe(409);
            const exact = await app.inject({ method: 'GET', url: route + '?query=' + encodeURIComponent(JSON.stringify({ recordId: first.recordId, witness: projection.frontier })), headers });
            expect(exact.statusCode, exact.body).toBe(200);
            expect(exact.json().entries[0]).toMatchObject({ id: witness.id, observedAtMs: witness.observedAtMs, record: { content: { t: 'plain', v: first } } });
            await db.providerAccountUsageRecord.update({ where: { accountId_recordId: { accountId: account.id, recordId: first.recordId } },
                data: { metadata: { pageProjection: { ...projection, content: { t: 'encrypted', c: 'opaque' } } } } });
            expect((await read()).statusCode).toBe(409);
            expect((await app.inject({ method: 'GET', url: documentUrl,
                headers: { ...headers, 'if-none-match': String(changed.headers.etag) } })).statusCode).toBe(409);
            await db.connectedServiceUsageSource.deleteMany({ where: { accountId: account.id } });
            expect((await put()).statusCode).toBe(404);
            expect((await read()).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: documentUrl,
                headers: { ...headers, 'if-none-match': String(changed.headers.etag) } })).statusCode).toBe(404);
        });
    });

    it("rejects record-id operations when the record has no qualified account source", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "unlinked-subject",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
        });
        await upsertProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const encodedRecordId =
                    encodeURIComponent(snapshot.recordId);
                const read = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record"
                        + `?recordId=${encodedRecordId}`,
                    headers,
                });
                expect(read.statusCode).toBe(404);

                const refresh = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record/refresh",
                    headers,
                    payload: { recordId: snapshot.recordId },
                });
                expect(refresh.statusCode).toBe(404);

                const remove = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record"
                        + `?recordId=${encodedRecordId}`,
                    headers,
                });
                expect(remove.statusCode).toBe(404);
            },
        );

        await expect(db.providerAccountUsageRecord.findFirstOrThrow({
            where: {
                accountId: account.id,
                recordId: snapshot.recordId,
            },
            select: { refreshRequestedAt: true },
        })).resolves.toEqual({ refreshRequestedAt: null });
    });

    it("maps a fail-closed credential storage-mode mismatch without exposing a server error", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const createdCredential = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/credential",
                    headers,
                    payload: {
                        ref,
                        authenticationModeId: "api-key",
                        expectedCredentialRevision: null,
                        content: {
                            t: "plain",
                            v: { token: "credential-secret" },
                        },
                        initialConfiguration: {
                            expectedConfigurationRevision: null,
                            replacementContentEnvelope: {
                                t: "plain",
                                v: { region: "eu" },
                            },
                        },
                        metadata: {
                            scopes: [],
                        },
                    },
                });
                expect(
                    createdCredential.statusCode,
                    createdCredential.body,
                ).toBe(200);

                await db.account.update({
                    where: { id: account.id },
                    data: {
                        publicKey: "e2ee-public-key",
                        encryptionMode: "e2ee",
                    },
                });

                const encodedRef =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountRefSchema,
                        ref,
                    );
                const response = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });

                expect(response.statusCode, response.body).toBe(400);
                expect(response.json()).toEqual({
                    error: "invalid-params",
                });

                const target = {
                    kind: "account" as const,
                    ref,
                };
                const encodedTarget =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountConfigurationTargetV4Schema,
                        target,
                    );
                const configurationResponse = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/configuration?target="
                        + encodeURIComponent(encodedTarget),
                    headers,
                });
                expect(
                    configurationResponse.statusCode,
                    configurationResponse.body,
                ).toBe(400);
                expect(configurationResponse.json()).toEqual({
                    error: "invalid-params",
                });

                const created = createdCredential.json();
                const deleteResponse = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef)
                        + `&expectedCredentialRevision=${encodeURIComponent(created.credentialRevision)}`
                        + "&cleanupGroupReferences=true",
                    headers,
                });
                expect(deleteResponse.statusCode, deleteResponse.body).toBe(400);
                expect(deleteResponse.json()).toEqual({
                    error: "invalid-params",
                });
            },
        );

        await expect(db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
    });

    it("refuses a legacy unfenced credential delete instead of reporting success", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const createdCredential = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/credential",
                    headers,
                    payload: {
                        ref,
                        authenticationModeId: "api-key",
                        expectedCredentialRevision: null,
                        content: {
                            t: "plain",
                            v: { token: "credential-secret" },
                        },
                        metadata: { scopes: [] },
                    },
                });
                expect(
                    createdCredential.statusCode,
                    createdCredential.body,
                ).toBe(200);
                const createdCredentialRevision =
                    createdCredential.json().credentialRevision as string;

                const createdGroup = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/groups",
                    headers,
                    payload: {
                        service,
                        group: { groupId: groupRef.groupId },
                    },
                });
                expect(createdGroup.statusCode, createdGroup.body).toBe(200);
                const group =
                    createdGroup.json()
                        .group as QualifiedConnectedAccountGroupV4;
                const addedMember = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/group/members",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        priority: 10,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(addedMember.statusCode, addedMember.body).toBe(200);

                // Retained legacy-unfenced storage: the credential carries no
                // revision, so the delete owner refuses before touching any row.
                await db.serviceAccountToken.updateMany({
                    where: { accountId: account.id },
                    data: {
                        metadata: {
                            v: 3,
                            storage: "plain_json_v1",
                            kind: "oauth",
                        },
                    },
                });

                const encodedRef =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountRefSchema,
                        ref,
                    );
                const deleteResponse = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef)
                        + "&expectedCredentialRevision="
                        + encodeURIComponent(createdCredentialRevision)
                        + "&cleanupGroupReferences=true",
                    headers,
                });
                expect(deleteResponse.statusCode, deleteResponse.body)
                    .toBe(400);
                expect(deleteResponse.json()).toEqual({
                    error: "invalid-params",
                });
            },
        );

        await expect(db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
        await expect(db.connectedServiceAuthGroupMember.count({
            where: { accountId: account.id },
        })).resolves.toBe(1);
    });

    it("rejects a pre-incarnation delete after the group id is recreated at the same counters", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const original = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/groups",
                    headers,
                    payload: {
                        service,
                        group: { groupId: groupRef.groupId },
                    },
                });
                expect(original.statusCode, original.body).toBe(200);
                expect(original.json()).toMatchObject({
                    group: {
                        ref: groupRef,
                        generation: 0,
                        runtimeStateRevision: 0,
                    },
                });
                const originalIncarnation =
                    original.json().group.incarnation as string;

                // Simulate the original lifetime being deleted before its
                // delayed request reaches the API. A replacement starts with
                // the same resettable counters and logical ref.
                await db.connectedServiceAuthGroup.deleteMany({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                });

                const recreated = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/groups",
                    headers,
                    payload: {
                        service,
                        group: { groupId: groupRef.groupId },
                    },
                });
                expect(recreated.statusCode, recreated.body).toBe(200);
                expect(recreated.json()).toMatchObject({
                    group: {
                        ref: groupRef,
                        generation: 0,
                        runtimeStateRevision: 0,
                    },
                });

                const encodedGroup =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountGroupRefSchema,
                        groupRef,
                    );
                const staleDelete = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedGeneration=0"
                        + "&expectedRuntimeStateRevision=0"
                        + "&expectedIncarnation="
                        + encodeURIComponent(originalIncarnation),
                    headers,
                });

                expect(staleDelete.statusCode, staleDelete.body).toBe(409);
                expect(staleDelete.json()).toEqual({
                    error: "connect_group_incarnation_conflict",
                });

                const listed = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/groups?service="
                        + encodeURIComponent(
                            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                                QualifiedConnectedAccountServiceRefSchema,
                                service,
                            ),
                        ),
                    headers,
                });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(listed.json()).toMatchObject({
                    groups: [{
                        ref: groupRef,
                        generation: 0,
                        runtimeStateRevision: 0,
                    }],
                });
            },
        );
    });

    it.each(["manual", "automatic"] as const)("ties the active member and switch clock for a %s selection", async (selection) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async (app) => {
            const primary = await app.inject({
                method: "POST", url: "/v4/connect/qualified/credential", headers,
                payload: {
                    ref, authenticationModeId: "api-key", expectedCredentialRevision: null,
                    content: { t: "plain", v: { token: "primary-secret" } },
                    metadata: {},
                },
            });
            expect(primary.statusCode, primary.body).toBe(200);
            const backup = { service, accountId: "backup" };
            const backupCredential = await app.inject({
                method: "POST", url: "/v4/connect/qualified/credential", headers,
                payload: {
                    ref: backup, authenticationModeId: "api-key", expectedCredentialRevision: null,
                    content: { t: "plain", v: { token: "backup-secret" } },
                    metadata: {},
                },
            });
            expect(backupCredential.statusCode, backupCredential.body).toBe(200);
            const created = await app.inject({
                method: "POST", url: "/v4/connect/qualified/groups", headers,
                payload: { service, group: { groupId: groupRef.groupId } },
            });
            expect(created.statusCode, created.body).toBe(200);
            let group = created.json().group as QualifiedConnectedAccountGroupV4;
            for (const member of [ref, backup]) {
                const added = await app.inject({
                    method: "POST", url: "/v4/connect/qualified/group/members", headers,
                    payload: {
                        group: groupRef, connectedAccountId: member.accountId,
                        expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision: group.runtimeStateRevision,
                    },
                });
                expect(added.statusCode, added.body).toBe(200);
                group = added.json().group;
            }
            const initialSelection = await app.inject({
                method: "POST", url: "/v4/connect/qualified/group/active-account", headers,
                payload: {
                    group: groupRef, connectedAccountId: ref.accountId,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                    expectedRuntimeStateRevision: group.runtimeStateRevision,
                },
            });
            expect(initialSelection.statusCode, initialSelection.body).toBe(200);
            group = initialSelection.json().group;
            expect(group.activeConnectedAccountId).toBe(ref.accountId);
            const beforeSwitchMs = Date.now();
            const switched = await app.inject({
                method: "POST", url: "/v4/connect/qualified/group/active-account", headers,
                payload: {
                    group: groupRef, connectedAccountId: backup.accountId,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                    expectedRuntimeStateRevision: group.runtimeStateRevision,
                    ...(selection === "automatic" ? {
                        expectedSource: {
                            connectedAccountId: ref.accountId,
                            credentialRevision: primary.json().credentialRevision,
                            configurationRevision: primary.json().configurationRevision,
                        },
                        overrideRuntimeCooldown: true,
                        switchReason: "usage_limit",
                    } : {}),
                },
            });
            expect(switched.statusCode, switched.body).toBe(200);
            group = switched.json().group;
            expect(group.activeConnectedAccountId).toBe(backup.accountId);
            expect(group.state.lastSwitchReason).toBe(selection === "automatic" ? "usage_limit" : "manual");
            expect(group.state.activeSince?.accountId).toBe(backup.accountId);
            expect(group.state.lastSwitchAt).toBe(group.state.activeSince?.atMs);
            expect(group.state.lastSwitchAt).toBeGreaterThanOrEqual(beforeSwitchMs);
            expect(group.state.lastSwitchAt).toBeLessThanOrEqual(Date.now());
            const selectedAt = group.state.lastSwitchAt;
            const selectedRevision = group.runtimeStateRevision;
            const patched = await app.inject({
                method: "PATCH", url: "/v4/connect/qualified/group/runtime-state", headers,
                payload: {
                    service, groupId: groupRef.groupId,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                    expectedRuntimeStateRevision: group.runtimeStateRevision,
                    runtimeState: { state: { status: "ready", lastSwitchAt: 1 }, memberStates: [] },
                },
            });
            expect(patched.statusCode, patched.body).toBe(200);
            group = patched.json().group;
            expect(group.runtimeStateRevision).toBe(selectedRevision + 1);
            expect(group.state.lastSwitchAt).toBe(selectedAt);
            expect(group.state.lastSwitchReason).toBe(selection === "automatic" ? "usage_limit" : "manual");
            expect(group.state.activeSince).toEqual({ accountId: backup.accountId, atMs: selectedAt });
            const beforeNoOp = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const beforeRows = await db.connectedServiceAuthGroup.findMany({ where: { accountId: account.id }, include: { members: true } });
            for (const runtimeState of [
                { memberStates: [] },
                { state: { lastSwitchAt: 1, status: "ready" }, memberStates: [] },
                { memberStates: group.members.map(member => ({ connectedAccountId: member.connectedAccountId, state: member.state })) },
            ]) {
                const equal = await app.inject({ method: "PATCH", url: "/v4/connect/qualified/group/runtime-state", headers,
                    payload: { service, groupId: groupRef.groupId, expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation, expectedRuntimeStateRevision: group.runtimeStateRevision, runtimeState } });
                expect(equal.statusCode, equal.body).toBe(200);
                expect(equal.json().group).toEqual(group);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(beforeNoOp);
                expect(await db.connectedServiceAuthGroup.findMany({ where: { accountId: account.id }, include: { members: true } })).toEqual(beforeRows);
            }
            const repeated = await app.inject({
                method: "POST", url: "/v4/connect/qualified/group/active-account", headers,
                payload: {
                    group: groupRef, connectedAccountId: backup.accountId,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                    expectedRuntimeStateRevision: group.runtimeStateRevision,
                },
            });
            expect(repeated.statusCode, repeated.body).toBe(200);
            expect(repeated.json().group.state.lastSwitchReason).toBe("manual");
            expect(repeated.json().group.state.lastSwitchAt).toBe(selectedAt);
        });
    });

    it('reads selected pool details through the Account Action and keeps another Account outside that pool', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none',
        });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        let headers = { 'x-test-user-id': account.id };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const created = await app.inject({ method: 'POST', url: '/v4/connect/qualified/groups', headers,
                payload: { service, group: { groupId: 'selected-detail', policy: { strategy: 'manual' } } } });
            expect(created.statusCode, created.body).toBe(200);
            let group = QualifiedConnectedAccountGroupResponseV4Schema.parse(created.json()).group;
            for (const [index, connectedAccountId] of ['first', 'second'].entries()) {
                const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                    ref: { service, accountId: connectedAccountId }, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                    content: { t: 'plain', v: { token: 'selected-detail-fixture' } }, metadata: { scopes: [] },
                } });
                expect(credential.statusCode, credential.body).toBe(200);
                const member = await app.inject({ method: 'POST', url: '/v4/connect/qualified/group/members', headers, payload: {
                    group: group.ref, connectedAccountId, priority: (index + 1) * 100, enabled: index !== 0,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                } });
                expect(member.statusCode, member.body).toBe(200);
                group = QualifiedConnectedAccountGroupResponseV4Schema.parse(member.json()).group;
            }
            const selected = await app.inject({ method: 'POST', url: '/v4/connect/qualified/group/active-account', headers, payload: {
                group: group.ref, connectedAccountId: 'second', expectedGeneration: group.generation,
                expectedIncarnation: group.incarnation, expectedRuntimeStateRevision: group.runtimeStateRevision,
            } });
            expect(selected.statusCode, selected.body).toBe(200);
            group = QualifiedConnectedAccountGroupResponseV4Schema.parse(selected.json()).group;
            const host: ConnectedServiceConfigurationActionHostV1 = {
                assertCurrent() {},
                async request(request) {
                    expect(request.method).toBe('GET');
                    const reply = await app.inject({ method: request.method, url: request.path, headers });
                    if (reply.statusCode !== 200) throw Object.assign(new Error('pool_read_refused'), { code: reply.json().error });
                    return reply.json();
                },
                async mutatePurposeBindings() { throw new Error('read_must_not_write'); },
                async resolveAgent() { throw new Error('read_must_not_probe'); },
                async resetQuota() { throw new Error('read_must_not_refresh'); },
            };
            const executor = createPoolActionExecutor(host);
            const read = () => executor.execute('connectedServices.pools.get', { group: group.ref },
                { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } });
            expect(await read()).toEqual({ ok: true, result: { group } });
            expect(group.members.map(member => [member.connectedAccountId, member.enabled])).toEqual([['first', false], ['second', true]]);
            expect(group.policy.strategy).toBe('manual');
            expect(group.activeConnectedAccountId).toBe('second');
            headers = { 'x-test-user-id': other.id };
            expect(await read()).toMatchObject({ ok: false, errorCode: 'connect_group_not_found' });
        });
    });

    it('keeps a failed pre-write pool read definite and reorders through the real owner on explicit retry', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none',
        });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const headers = { 'x-test-user-id': account.id };
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const created = await app.inject({ method: 'POST', url: '/v4/connect/qualified/groups', headers,
                payload: { service, group: { groupId: 'move-up' } } });
            expect(created.statusCode, created.body).toBe(200);
            let group = QualifiedConnectedAccountGroupResponseV4Schema.parse(created.json()).group;
            for (const [index, connectedAccountId] of ['first', 'second'].entries()) {
                const credential = await app.inject({ method: 'POST', url: '/v4/connect/qualified/credential', headers, payload: {
                    ref: { service, accountId: connectedAccountId }, authenticationModeId: 'api-key', expectedCredentialRevision: null,
                    content: { t: 'plain', v: { token: 'pool-reorder-fixture' } }, metadata: { scopes: [] },
                } });
                expect(credential.statusCode, credential.body).toBe(200);
                const member = await app.inject({ method: 'POST', url: '/v4/connect/qualified/group/members', headers, payload: {
                    group: group.ref, connectedAccountId, priority: (index + 1) * 100, enabled: index !== 0,
                    expectedGeneration: group.generation, expectedIncarnation: group.incarnation,
                } });
                expect(member.statusCode, member.body).toBe(200);
                group = QualifiedConnectedAccountGroupResponseV4Schema.parse(member.json()).group;
            }
            const groupUrl = '/v4/connect/qualified/group?group=' + encodeURIComponent(
                encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, group.ref),
            );
            const readGroup = async () => {
                const reply = await app.inject({ method: 'GET', url: groupUrl, headers });
                expect(reply.statusCode, reply.body).toBe(200);
                return QualifiedConnectedAccountGroupResponseV4Schema.parse(reply.json()).group;
            };
            let readUnavailable = true;
            let writeRequests = 0;
            let actionReads = 0;
            // Only HTTP is substituted: the captured browser failure occurs before its first GET.
            // Admitted requests use real routes, schemas, CAS transactions and isolated SQLite storage.
            const host: ConnectedServiceConfigurationActionHostV1 = {
                assertCurrent() {},
                async request(request) {
                    if (request.method === 'GET') {
                        actionReads += 1;
                        if (readUnavailable) throw new TypeError('Failed to fetch');
                    } else writeRequests += 1;
                    const reply = await app.inject({ method: request.method, url: request.path, headers,
                        ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body),
                            headers: { ...headers, 'content-type': 'application/json' } }),
                    });
                    if (reply.statusCode !== 200) {
                        throw Object.assign(new Error('Qualified pool request refused'), { code: reply.json().error });
                    }
                    return reply.json();
                },
                async mutatePurposeBindings() { throw new Error('reorder_must_not_change_defaults'); },
                async resolveAgent() { throw new Error('reorder_must_not_probe'); },
                async resetQuota() { throw new Error('reorder_must_not_refresh_quota'); },
            };
            const executor = createPoolActionExecutor(host);
            const moveUp = () => executor.execute('connectedServices.pools.reorder', { group: group.ref,
                move: { accountId: 'second', position: { anchorId: 'first', placement: 'before' } },
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
            const failed = await moveUp();
            expect(writeRequests).toBe(0);
            expect(actionReads).toBe(1); // No implicit retry or polling after a failed read.
            expect(await readGroup()).toEqual(group);
            expect(await readGroup()).toEqual(group);
            expect(failed).toMatchObject({ ok: false, errorCode: 'connect_group_read_failed' });

            readUnavailable = false;
            expect(await moveUp()).toEqual({ ok: true, result: { applied: true } });
            const settled = await readGroup();
            expect(writeRequests).toBe(2);
            expect(actionReads).toBe(2);
            expect(settled.generation).toBe(group.generation + 2);
            expect(settled.runtimeStateRevision).toBe(group.runtimeStateRevision);
            expect(settled.members.map(member => [member.connectedAccountId, member.priority, member.enabled]))
                .toEqual([['second', 100, true], ['first', 200, false]]);
            expect(await readGroup()).toEqual(settled);
        });
    });

    it("serves every advertised operation through the canonical qualified repositories", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const createdCredential = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/credential",
                    headers,
                    payload: {
                        ref,
                        authenticationModeId: "api-key",
                        expectedCredentialRevision: null,
                        content: {
                            t: "plain",
                            v: { token: "credential-secret" },
                        },
                        metadata: {
                            providerIdentity: {
                                accountId: "acct-v4",
                                email: "account@example.com",
                            },
                            scopes: ["account.read"],
                        },
                        initialConfiguration: {
                            expectedConfigurationRevision: null,
                            replacementContentEnvelope: {
                                t: "plain",
                                v: { region: "eu" },
                            },
                        },
                    },
                });
                expect(createdCredential.statusCode).toBe(200);
                const createdCredentialBody = createdCredential.json() as {
                    credentialRevision: string;
                    configurationRevision: string;
                };

                const encodedService =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountServiceRefSchema,
                        service,
                    );
                const listedAccounts = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/accounts?service="
                        + encodeURIComponent(encodedService),
                    headers,
                });
                expect(listedAccounts.statusCode).toBe(200);
                expect(listedAccounts.json()).toMatchObject({
                    service,
                    accounts: [{
                        ref,
                        credentialRevision:
                            createdCredentialBody.credentialRevision,
                        configurationRevision:
                            createdCredentialBody.configurationRevision,
                    }],
                });

                const encodedRef =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountRefSchema,
                        ref,
                    );
                const readCredential = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(readCredential.statusCode).toBe(200);
                expect(readCredential.json()).toMatchObject({
                    ref,
                    credentialRevision:
                        createdCredentialBody.credentialRevision,
                    configurationRevision:
                        createdCredentialBody.configurationRevision,
                    content: {
                        t: "plain",
                        v: { token: "credential-secret" },
                    },
                });

                const configurationTarget = {
                    kind: "account",
                    ref,
                } as const;
                const encodedTarget =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountConfigurationTargetV4Schema,
                        configurationTarget,
                    );
                const readConfiguration = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/configuration?target="
                        + encodeURIComponent(encodedTarget),
                    headers,
                });
                expect(readConfiguration.statusCode).toBe(200);
                expect(readConfiguration.json()).toMatchObject({
                    target: configurationTarget,
                    credentialRevision:
                        createdCredentialBody.credentialRevision,
                    configurationRevision:
                        createdCredentialBody.configurationRevision,
                    configurationContent: {
                        t: "plain",
                        v: { region: "eu" },
                    },
                });

                const patchedConfiguration = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/configuration",
                    headers,
                    payload: {
                        target: configurationTarget,
                        expectedCredentialRevision:
                            createdCredentialBody.credentialRevision,
                        expectedConfigurationRevision:
                            createdCredentialBody.configurationRevision,
                        replacementContentEnvelope: {
                            t: "plain",
                            v: { region: "us" },
                        },
                    },
                });
                expect(patchedConfiguration.statusCode).toBe(200);
                const patchedConfigurationBody =
                    patchedConfiguration.json() as {
                        credentialRevision: string;
                        configurationRevision: string;
                    };
                expect(
                    patchedConfigurationBody.configurationRevision,
                ).not.toBe(createdCredentialBody.configurationRevision);

                const patchedHealth = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/credential/health",
                    headers,
                    payload: {
                        ref,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        expectedConfigurationRevision:
                            patchedConfigurationBody.configurationRevision,
                        health: {
                            v: 1,
                            status: "needs_reauth",
                            reconnectRequired: true,
                        },
                    },
                });
                expect(patchedHealth.statusCode).toBe(200);

                const acquiredLease = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/credential/refresh-lease",
                    headers,
                    payload: {
                        ref,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        ownerId: "daemon:one",
                        ttlMs: 30_000,
                    },
                });
                expect(acquiredLease.statusCode).toBe(200);
                expect(acquiredLease.json()).toMatchObject({
                    acquired: true,
                    ownerId: "daemon:one",
                    credentialRevision:
                        patchedConfigurationBody.credentialRevision,
                });

                const createdGroup = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/groups",
                    headers,
                    payload: {
                        service,
                        group: {
                            groupId: groupRef.groupId,
                            displayName: "Primary",
                        },
                    },
                });
                expect(createdGroup.statusCode).toBe(200);
                let group =
                    createdGroup.json()
                        .group as QualifiedConnectedAccountGroupV4;

                const staleMemberCreate = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/group/members",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation + 1,
                        expectedIncarnation: group.incarnation,
                    },
                });
                expect(staleMemberCreate.statusCode).toBe(409);
                expect(staleMemberCreate.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const listedGroups = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/groups?service="
                        + encodeURIComponent(encodedService),
                    headers,
                });
                expect(listedGroups.statusCode).toBe(200);
                expect(listedGroups.json()).toMatchObject({
                    groups: [{ ref: groupRef }],
                });

                const addedMember = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/group/members",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        priority: 10,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(addedMember.statusCode).toBe(200);
                group = addedMember.json().group;

                const staleActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation - 1,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(staleActive.statusCode).toBe(409);
                expect(staleActive.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const setActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(setActive.statusCode).toBe(200);
                group = setActive.json().group;

                const staleSourceActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        expectedSource: {
                            connectedAccountId: ref.accountId,
                            credentialRevision:
                                "csr_abcdefghijklmnopqrstuv",
                            configurationRevision:
                                patchedConfigurationBody
                                    .configurationRevision,
                        },
                    },
                });
                expect(staleSourceActive.statusCode).toBe(409);
                expect(staleSourceActive.json()).toEqual({
                    error: "connect_group_source_revision_conflict",
                });

                const currentSourceActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        expectedSource: {
                            connectedAccountId: ref.accountId,
                            credentialRevision:
                                patchedConfigurationBody
                                    .credentialRevision,
                            configurationRevision:
                                patchedConfigurationBody
                                    .configurationRevision,
                        },
                    },
                });
                expect(currentSourceActive.statusCode).toBe(200);
                group = currentSourceActive.json().group;

                const staleGroupPatch = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        expectedGeneration: group.generation - 1,
                        expectedIncarnation: group.incarnation,
                        displayName: "Stale rename",
                    },
                });
                expect(staleGroupPatch.statusCode).toBe(409);
                expect(staleGroupPatch.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const patchedGroup = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        expectedGeneration: group.generation,
                        displayName: "Renamed",
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(patchedGroup.statusCode).toBe(200);
                group = patchedGroup.json().group;

                const staleRuntimeState = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group/runtime-state",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        expectedGeneration: group.generation - 1,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        runtimeState: { memberStates: [] },
                    },
                });
                expect(staleRuntimeState.statusCode).toBe(409);
                expect(staleRuntimeState.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const patchedRuntimeState = await app.inject({
                    method: "PATCH",
                    url:
                        "/v4/connect/qualified/group/runtime-state",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        runtimeState: {
                            state: { status: "ready" },
                            memberStates: [{
                                connectedAccountId: ref.accountId,
                                state: {
                                    lastObservedAtMs: 1,
                                    quotaExhaustedUntilMs:
                                        Date.now() + 60_000,
                                },
                            }],
                        },
                    },
                });
                expect(patchedRuntimeState.statusCode).toBe(200);
                group = patchedRuntimeState.json().group;

                const runtimeBlockerResetAtMs =
                    group.members[0].state.quotaExhaustedUntilMs as number;
                const blockedActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(blockedActive.statusCode).toBe(409);
                expect(blockedActive.json()).toEqual({
                    error: "connect_group_profile_runtime_cooldown",
                    resetAtMs: runtimeBlockerResetAtMs,
                });

                const overriddenActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        overrideRuntimeCooldown: true,
                    },
                });
                expect(overriddenActive.statusCode).toBe(200);
                group = overriddenActive.json().group;

                const staleMemberUpdate = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group/member",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation - 1,
                        expectedIncarnation: group.incarnation,
                        priority: 19,
                    },
                });
                expect(staleMemberUpdate.statusCode).toBe(409);
                expect(staleMemberUpdate.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const autoDisabledMember = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group/member",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        enabled: false,
                        state: {
                            autoDisabledReason: "model_not_entitled",
                            lastFailureCode: "model_not_entitled",
                            modelUnavailableUntilMsByModelId: {
                                "gpt-5.6-sol": 86_400_000,
                            },
                        },
                    },
                });
                expect(autoDisabledMember.statusCode, autoDisabledMember.body).toBe(200);
                group = autoDisabledMember.json().group;

                const updatedMember = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group/member",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        priority: 20,
                        enabled: true,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(updatedMember.statusCode).toBe(200);
                group = updatedMember.json().group;
                expect(group.members.find((member) =>
                    member.connectedAccountId === ref.accountId,
                )?.state).toEqual({});
                const reactivatedMember = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedIncarnation: group.incarnation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        overrideRuntimeCooldown: true,
                    },
                });
                expect(reactivatedMember.statusCode).toBe(200);
                group = reactivatedMember.json().group;

                const staleMemberDeleteMutation = {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration: group.generation - 1,
                    expectedIncarnation: group.incarnation,
                };
                const staleMemberDelete = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group/member?mutation="
                        + encodeURIComponent(
                            encodeQualifiedConnectedAccountV4StructuredQueryValue(
                                QualifiedConnectedAccountGroupMemberDeleteV4Schema,
                                staleMemberDeleteMutation,
                            ),
                        ),
                    headers,
                });
                expect(staleMemberDelete.statusCode).toBe(409);
                expect(staleMemberDelete.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const encodedGroup =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountGroupRefSchema,
                        groupRef,
                    );
                const readGroup = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedRuntimeStateRevision="
                        + group.runtimeStateRevision,
                    headers,
                });
                expect(readGroup.statusCode).toBe(200);
                expect(readGroup.json()).toMatchObject({
                    group: {
                        ref: groupRef,
                        displayName: "Renamed",
                        activeConnectedAccountId: ref.accountId,
                        state: { status: "ready" },
                        members: [{
                            connectedAccountId: ref.accountId,
                            priority: 20,
                        }],
                    },
                });

                const memberDelete = {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration: group.generation,
                    expectedIncarnation: group.incarnation,
                    expectedRuntimeStateRevision:
                        group.runtimeStateRevision,
                };
                const encodedMemberDelete =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountGroupMemberDeleteV4Schema,
                        memberDelete,
                    );
                const deletedMember = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group/member?mutation="
                        + encodeURIComponent(encodedMemberDelete),
                    headers,
                });
                expect(deletedMember.statusCode).toBe(200);
                group = deletedMember.json().group;

                const staleGroupDelete = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedGeneration="
                        + (group.generation - 1)
                        + "&expectedIncarnation="
                        + encodeURIComponent(group.incarnation),
                    headers,
                });
                expect(staleGroupDelete.statusCode).toBe(409);
                expect(staleGroupDelete.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const deletedGroup = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedGeneration="
                        + group.generation
                        + "&expectedRuntimeStateRevision="
                        + group.runtimeStateRevision
                        + "&expectedIncarnation="
                        + encodeURIComponent(group.incarnation),
                    headers,
                });
                expect(deletedGroup.statusCode).toBe(200);
                expect(deletedGroup.json()).toEqual({ success: true });

                const recordKey =
                    createProviderAccountUsageRecordKey({
                        accountSubjectId: "acct-v4",
                    });
                const snapshot = createUsageSnapshot({
                    fetchedAt: Date.now(),
                    recordKey,
                    planLabel: "V4 plan",
                });
                const writtenUsage = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage",
                    headers,
                    payload: {
                        source,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        expectedConfigurationRevision:
                            patchedConfigurationBody.configurationRevision,
                        recordId: snapshot.recordId,
                        recordKey: snapshot.recordKey,
                        payloadMode: "plain_json_v1",
                        status: "ok",
                        snapshot,
                        fetchedAt: snapshot.fetchedAtMs,
                        staleAfterMs: snapshot.staleAfterMs,
                    },
                });
                expect(writtenUsage.statusCode).toBe(200);
                expect(writtenUsage.json()).toEqual({
                    success: true,
                    source: { status: "linked" },
                });


                const encodedSource =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedServiceUsageSourceV4Schema,
                        source,
                    );
                const resolvedSource = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/sources/resolve?source="
                        + encodeURIComponent(encodedSource),
                    headers,
                });
                expect(resolvedSource.statusCode).toBe(200);
                expect(resolvedSource.json()).toMatchObject({
                    source,
                    recordId: snapshot.recordId,
                    providerAccountId: "acct-v4",
                });

                const readUsageRecord = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(readUsageRecord.statusCode).toBe(200);
                expect(readUsageRecord.json()).toMatchObject({
                    content: {
                        t: "plain",
                        v: { recordId: snapshot.recordId },
                    },
                    sources: [source],
                });

                await db.providerAccountUsageRecord.update({
                    where: {
                        accountId_recordId: {
                            accountId: account.id,
                            recordId: snapshot.recordId,
                        },
                    },
                    data: {
                        payloadMode: "sealed_account_scoped_v1",
                        snapshot: prismaRuntime.DbNull,
                        sealedPayload: {
                            format: "account_scoped_v1",
                            ciphertext: "opaque-sealed-payload",
                        },
                    },
                });
                const payloadModeMismatchRead = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(payloadModeMismatchRead.statusCode).toBe(409);
                expect(payloadModeMismatchRead.json()).toEqual({
                    error:
                        "provider_account_usage_storage_mode_mismatch",
                });
                await db.providerAccountUsageRecord.update({
                    where: {
                        accountId_recordId: {
                            accountId: account.id,
                            recordId: snapshot.recordId,
                        },
                    },
                    data: {
                        payloadMode: "plain_json_v1",
                        snapshot,
                        sealedPayload: prismaRuntime.DbNull,
                    },
                });

                await db.account.update({
                    where: { id: account.id },
                    data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() },
                });
                const modeMismatchRead = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(modeMismatchRead.statusCode).toBe(409);
                expect(modeMismatchRead.json()).toEqual({
                    error:
                        "provider_account_usage_storage_mode_mismatch",
                });

                const modeMismatchQuota = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/quotas?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(modeMismatchQuota.statusCode).toBe(409);
                expect(modeMismatchQuota.json()).toEqual({
                    error:
                        "provider_account_usage_storage_mode_mismatch",
                });

                const beforeMismatchMutation =
                    await db.providerAccountUsageRecord.findUnique({
                        where: {
                            accountId_recordId: {
                                accountId: account.id,
                                recordId: snapshot.recordId,
                            },
                        },
                        select: {
                            payloadMode: true,
                            refreshRequestedAt: true,
                        },
                    });
                const modeMismatchRefresh = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record/refresh",
                    headers,
                    payload: { recordId: snapshot.recordId },
                });
                expect(modeMismatchRefresh.statusCode).toBe(409);
                expect(modeMismatchRefresh.json()).toEqual({
                    error:
                        "provider_account_usage_storage_mode_mismatch",
                });
                const afterMismatchMutation =
                    await db.providerAccountUsageRecord.findUnique({
                        where: {
                            accountId_recordId: {
                                accountId: account.id,
                                recordId: snapshot.recordId,
                            },
                        },
                        select: {
                            payloadMode: true,
                            refreshRequestedAt: true,
                        },
                    });
                expect(afterMismatchMutation).toEqual(
                    beforeMismatchMutation,
                );
                const modeMismatchQuotaRefresh = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/quotas/refresh",
                    headers,
                    payload: { ref },
                });
                expect(modeMismatchQuotaRefresh.statusCode).toBe(409);
                expect(modeMismatchQuotaRefresh.json()).toEqual({
                    error: "provider_account_usage_storage_mode_mismatch",
                });
                const modeMismatchUnlink = await app.inject({
                    method: "DELETE",
                    url: "/v4/connect/qualified/quotas?ref=" + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(modeMismatchUnlink.statusCode).toBe(409);
                expect(modeMismatchUnlink.json()).toEqual({
                    error: "provider_account_usage_storage_mode_mismatch",
                });
                const modeMismatchDeleteRecord = await app.inject({
                    method: "DELETE",
                    url: "/v4/connect/qualified/provider-account-usage/record?recordId=" + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(modeMismatchDeleteRecord.statusCode).toBe(409);
                expect(modeMismatchDeleteRecord.json()).toEqual({
                    error: "provider_account_usage_storage_mode_mismatch",
                });
                const sealedSubscription = {
                    observedAtMs: snapshot.fetchedAtMs - 1,
                    ciphertext: "opaque-0.2-subscription",
                };
                await db.providerAccountUsageRecord.update({
                    where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
                    data: {
                        payloadMode: "sealed_account_scoped_v1",
                        snapshot: prismaRuntime.DbNull,
                        sealedPayload: {
                            format: "account_scoped_v1",
                            ciphertext: "opaque-0.2-base",
                            subscription: sealedSubscription,
                        },
                    },
                });
                const sealedRecordRead = await app.inject({
                    method: "GET",
                    url: "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(sealedRecordRead.statusCode).toBe(200);
                expect(sealedRecordRead.json().content).toEqual({
                    t: "encrypted",
                    c: "opaque-0.2-base",
                    subscription: sealedSubscription,
                });
                const sealedQuotaRead = await app.inject({
                    method: "GET",
                    url: "/v4/connect/qualified/quotas?ref=" + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(sealedQuotaRead.statusCode).toBe(200);
                expect(sealedQuotaRead.json().content).toEqual(sealedRecordRead.json().content);
                await db.account.update({
                    where: { id: account.id },
                    data: { encryptionMode: "plain" },
                });
                await db.providerAccountUsageRecord.update({
                    where: { accountId_recordId: { accountId: account.id, recordId: snapshot.recordId } },
                    data: {
                        payloadMode: "plain_json_v1",
                        snapshot,
                        sealedPayload: prismaRuntime.DbNull,
                    },
                });

                await db.connectedServiceUsageSource.updateMany({
                    where: {
                        accountId: account.id,
                        providerAccountUsageRecordId:
                            snapshot.recordId,
                    },
                    data: { bindingKind: "unsupported" },
                });
                const unsupportedSourceRecord =
                    await app.inject({
                        method: "GET",
                        url:
                            "/v4/connect/qualified/provider-account-usage/record?recordId="
                            + encodeURIComponent(snapshot.recordId),
                        headers,
                    });
                expect(unsupportedSourceRecord.statusCode).toBe(404);
                await db.connectedServiceUsageSource.updateMany({
                    where: {
                        accountId: account.id,
                        providerAccountUsageRecordId:
                            snapshot.recordId,
                    },
                    data: { bindingKind: "account" },
                });

                const readQuota = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/quotas?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(readQuota.statusCode).toBe(200);
                expect(readQuota.json()).toMatchObject({
                    ref,
                    content: {
                        t: "plain",
                        v: {
                            ref,
                            planLabel: "V4 plan",
                        },
                    },
                });

                const refreshedQuota = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/quotas/refresh",
                    headers,
                    payload: { ref },
                });
                expect(
                    refreshedQuota.statusCode,
                    refreshedQuota.body,
                ).toBe(200);

                const refreshedUsageRecord = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record/refresh",
                    headers,
                    payload: { recordId: snapshot.recordId },
                });
                expect(refreshedUsageRecord.statusCode).toBe(200);

                const deletedQuota = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/quotas?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(deletedQuota.statusCode).toBe(200);

                const deletedUsageRecord = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(deletedUsageRecord.statusCode).toBe(404);
                expect(deletedUsageRecord.json()).toEqual({
                    error: "provider_account_usage_not_found",
                });

                const deletedCredential = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef)
                        + "&expectedCredentialRevision="
                        + encodeURIComponent(
                            patchedConfigurationBody.credentialRevision,
                        )
                        + "&cleanupGroupReferences=false",
                    headers,
                });
                expect(deletedCredential.statusCode).toBe(200);
                expect(deletedCredential.json()).toEqual({
                    success: true,
                });
            },
        );
    });
});
