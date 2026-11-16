import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import { db } from "@/storage/db";
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { withSqliteReadSnapshot } from '@/storage/prisma';
import { sealProviderAccountUsageSnapshot, openSealedProviderAccountUsageSnapshot } from "@happier-dev/protocol/connect/accountUsage";
import { ConnectedServiceQuotaSnapshotV1Schema } from "@happier-dev/protocol";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    ConnectedServiceUsageSourceBindingError,
} from "../providerAccountUsage/types";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    mutateQualifiedConnectedServiceCredential,
} from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
} from "./groupRepository";
import { resolveLegacyQualifiedConnectedAccountService } from "./identity";
import { projectProviderAccountUsageSnapshotToLegacyQuota } from "./legacyUsageTranslation";
import {
    listQualifiedUsageSourcesForRecord,
    readQualifiedConnectedAccountUsageRecord,
    readExactQualifiedConnectedServiceUsageSource,
    readQualifiedConnectedAccountQuota,
    readQualifiedProviderAccountUsageHistory,
    requestQualifiedConnectedAccountQuotaRefresh,
    requestQualifiedProviderAccountUsageRefresh,
    unlinkQualifiedConnectedAccountQuota,
    writeQualifiedProviderAccountUsageRecord,
    writeLegacyConnectedServiceQuotaCompatibilityRecord,
} from "./usageRepository";

const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "identity-guard",
});
const providerAccountId = "provider-identity-guard";

describe("qualified Connected Account usage stored identity", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-usage-identity-",
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        await db.serviceAccountToken.deleteMany();
        await db.account.deleteMany();
    });

    async function createCredential(accountId: string, encrypted = false, credentialService: Parameters<typeof mutateQualifiedConnectedServiceCredential>[0]["ref"]["service"] = service) {
        const ref = {
            service: credentialService,
            accountId: "qualified-account",
        };
        const credential =
            await mutateQualifiedConnectedServiceCredential({
                accountId,
                ref,
                expectedCredentialRevision: null,
                authenticationModeId: "api-key",
                content: encrypted ? { t: "encrypted", c: "opaque-e2ee-credential" } : {
                    t: "plain",
                    v: { token: "credential" },
                },
                metadata: {
                    scopes: [],
                    providerIdentity: {
                        accountId: providerAccountId,
                    },
                },
            });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential create");
        }
        return { credential, ref };
    }

    it.each([false, true])('accepts Refresh after source registration without a provider sample (encrypted=%s)', async encrypted => {
        const account = await db.account.create({ data: encrypted
            ? { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const { ref, credential } = await createCredential(account.id, encrypted);
        expect(await readQualifiedConnectedAccountQuota({ accountId: account.id, ref })).toEqual({ status: 'no_usage_observed' });
        expect(await requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id, ref })).toBe('no_usage_observed');
        expect(await requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id,
            ref: { ...ref, accountId: 'missing' } })).toBe('not_found');
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const response = await app.inject({ method: 'POST', url: '/v4/connect/qualified/quotas/refresh',
                headers: { 'x-test-user-id': account.id }, payload: { ref } });
            expect(response.statusCode, response.body).toBe(404);
            expect(response.json()).toEqual({ error: 'no_usage_observed' });
        });
        const write = buildUsageWrite(account.id, { credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: 0, planLabel: 'unobserved' });
        const snapshot = { ...write.snapshot, state: 'not_loaded' as const,
            observedAtMs: 0, fetchedAtMs: 0, confidence: 'unknown' as const, meters: [] };
        const { snapshot: _snapshot, ...base } = write;
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        expect(await writeQualifiedProviderAccountUsageRecord({ ...base, status: 'unavailable',
            ...(encrypted ? { payloadMode: 'sealed_account_scoped_v1' as const,
                sealedPayload: sealProviderAccountUsageSnapshot({ material, snapshot, randomBytes: length => new Uint8Array(length).fill(3) }) }
                : { snapshot }),
        })).toMatchObject({ record: { fetchedAt: 0, status: 'unavailable' }, sourceOutcome: { status: 'linked' } });
        await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
            const response = await app.inject({ method: 'POST', url: '/v4/connect/qualified/quotas/refresh',
                headers: { 'x-test-user-id': account.id }, payload: { ref } });
            expect(response.statusCode, response.body).toBe(200);
        });
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref }))
            .toMatchObject({ fetchedAt: 0, status: 'unavailable', refreshRequestedAt: expect.any(Number) });
    });

    function buildUsageWrite(
        accountId: string,
        params: Readonly<{
            credentialRevision: string;
            source: Parameters<
                typeof writeQualifiedProviderAccountUsageRecord
            >[0]["source"];
            fetchedAt: number;
            planLabel: string;
        }>,
    ) {
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: providerAccountId,
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: params.fetchedAt,
            recordKey,
            planLabel: params.planLabel,
        });
        return {
            accountId,
            source: params.source,
            expectedCredentialRevision:
                params.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1" as const,
            status: "ok" as const,
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        };
    }

    it.each([
        { encrypted: false, fingerprint: undefined },
        { encrypted: false, fingerprint: 'unchanged-material' },
        { encrypted: true, fingerprint: undefined },
        { encrypted: true, fingerprint: 'unchanged-material' },
    ])('settles a failed quota refresh without advancing the last provider observation (%j)', async ({ encrypted, fingerprint }) => {
        const account = await db.account.create({ data: encrypted
            ? { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const { credential, ref } = await createCredential(account.id, encrypted);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' },
            fetchedAt: Date.now() - 60_000,
            planLabel: 'Last known plan',
        });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const publish = async (snapshot: typeof write.snapshot, status: 'ok' | 'error') => {
            const { snapshot: _snapshot, ...base } = write;
            return await writeQualifiedProviderAccountUsageRecord({ ...base, status, materialFingerprint: fingerprint,
                ...(encrypted ? { payloadMode: 'sealed_account_scoped_v1' as const,
                    sealedPayload: sealProviderAccountUsageSnapshot({ material, snapshot, randomBytes: length => new Uint8Array(length).fill(3) }) }
                    : { snapshot }),
            });
        };
        await publish(write.snapshot, 'ok');
        expect(await requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id, ref })).toBe('written');
        const pending = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(pending?.refreshRequestedAt).toBeDefined();
        const oldFailureAt = write.fetchedAt;
        await publish({ ...write.snapshot, state: 'error_last_known_good',
            diagnostics: [{ kind: 'provider_http', code: 'provider_backoff', status: 429, observedAtMs: oldFailureAt }] }, 'error');
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref }))
            .toMatchObject({ status: 'error', fetchedAt: write.fetchedAt, refreshRequestedAt: pending!.refreshRequestedAt });
        const observedAtMs = Date.now();
        const retryAtMs = observedAtMs + 45_000;
        const failedSnapshot = { ...write.snapshot, state: 'error_last_known_good' as const,
            diagnostics: [{ kind: 'provider_http' as const, code: 'provider_backoff', status: 429, observedAtMs, retryAtMs }] };
        await publish(failedSnapshot, 'error');
        const result = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(result).toMatchObject({ status: 'error', fetchedAt: write.fetchedAt });
        const snapshot = result?.snapshot ?? (result?.sealedPayload
            ? openSealedProviderAccountUsageSnapshot({ material, sealed: result.sealedPayload }) : null);
        expect(snapshot).toMatchObject({ state: 'error_last_known_good',
            fetchedAtMs: write.fetchedAt, observedAtMs: write.snapshot.observedAtMs,
            meters: write.snapshot.meters, diagnostics: [{ kind: 'provider_http', status: 429, retryAtMs }] });
        expect(result).not.toHaveProperty('refreshRequestedAt');
        // Late outcomes cannot overwrite the newer failure or revive its request.
        await publish({ ...failedSnapshot, diagnostics: [{ ...failedSnapshot.diagnostics[0], observedAtMs: oldFailureAt }] }, 'error');
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref })).toEqual(result);
    });

    it.each([false, true])('does not restore an old-observation failure after an equal-time successful observation (encrypted=%s)', async encrypted => {
        const account = await db.account.create({ data: encrypted
            ? { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' }
            : { publicKey: null, encryptionMode: 'plain' } });
        const { credential, ref } = await createCredential(account.id, encrypted);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: 1000, planLabel: 'Retained plan',
        });
        const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
        const publish = async (snapshot: typeof write.snapshot, status: 'ok' | 'error') => {
            const { snapshot: _snapshot, ...base } = write;
            return await writeQualifiedProviderAccountUsageRecord({ ...base, status, fetchedAt: snapshot.fetchedAtMs,
                ...(encrypted ? { payloadMode: 'sealed_account_scoped_v1' as const,
                    sealedPayload: sealProviderAccountUsageSnapshot({ material, snapshot, randomBytes: length => new Uint8Array(length).fill(3) }) }
                    : { snapshot }),
            });
        };
        const oldFailure = { ...write.snapshot, state: 'error_last_known_good' as const,
            diagnostics: [{ kind: 'provider_http' as const, status: 429, observedAtMs: 2000 }] };
        await publish(oldFailure, 'error');
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref }))
            .toMatchObject({ status: 'error', fetchedAt: 1000 });
        await publish({ ...write.snapshot, fetchedAtMs: 2000, observedAtMs: 2000 }, 'ok');
        const successful = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(successful).toMatchObject({ status: 'ok', fetchedAt: 2000 });
        await publish(oldFailure, 'error');
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref })).toEqual(successful);
    });

    it.each(['record', 'account'] as const)('publishes an exact quota-refresh wake after the %s refresh marker commits', async target => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const { credential, ref } = await createCredential(account.id);
        const write = buildUsageWrite(account.id, { credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: Date.now(), planLabel: 'Work' });
        await writeQualifiedProviderAccountUsageRecord(write);
        const result = target === 'record'
            ? await requestQualifiedProviderAccountUsageRefresh({ accountId: account.id, recordId: write.recordId })
            : await requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id, ref });
        expect(result).toBe('written');
        expect(await db.providerAccountUsageRecord.findFirstOrThrow({ where: { accountId: account.id, recordId: write.recordId } }))
            .toMatchObject({ refreshRequestedAt: expect.any(Date) });
        const change = await db.accountChange.findFirst({ where: { accountId: account.id,
            kind: 'account', entityId: `provider-account-usage-refresh:${write.recordId}` } });
        expect(change).toMatchObject({ hint: { providerAccountUsageRefresh: true, recordId: write.recordId } });
        const { ProviderAccountUsageRefreshChangeV1Schema } = await import('@happier-dev/protocol/changes');
        expect(ProviderAccountUsageRefreshChangeV1Schema.parse({ kind: change!.kind, entityId: change!.entityId, hint: change!.hint }))
            .toMatchObject({ hint: { recordId: write.recordId } });
    });

    it('does not link historical account-scoped usage after the credential has an attested organization', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const ref = { service, accountId: 'attested-organization' };
        const credential = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'org-token' } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId, organizationId: 'org-a' } },
        });
        if (credential.status !== 'written') throw new Error('Expected credential create');
        const write = buildUsageWrite(account.id, { credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: Date.now(), planLabel: 'legacy account scope' });
        await expect(writeQualifiedProviderAccountUsageRecord(write)).rejects.toMatchObject({ kind: 'mismatch' });
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref })).toBeNull();
    });

    it.each(['org-b', undefined] as const)('unlinks all usage aliases when the same provider user changes organization context to %s', async organizationId => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const ref = { service, accountId: 'organization-context' };
        const created = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'org-a-token' } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId, organizationId: 'org-a' } },
        });
        if (created.status !== 'written') throw new Error('Expected credential create');
        const groupRef = { service, groupId: 'organization-context-group' };
        const group = await createQualifiedConnectedAccountGroup({ accountId: account.id, service, group: { groupId: groupRef.groupId } });
        if (group.status !== 'written') throw new Error('Expected group create');
        const member = await createQualifiedConnectedAccountGroupMember({ accountId: account.id, mutation: { group: groupRef,
            connectedAccountId: ref.accountId, expectedGeneration: group.group.generation,
            expectedRuntimeStateRevision: group.group.runtimeStateRevision } });
        if (member.status !== 'written') throw new Error('Expected group member create');
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: providerAccountId, quotaScope: 'organization', quotaScopeId: 'org-a' });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });
        const write = { accountId: account.id, expectedCredentialRevision: created.credentialRevision,
            expectedConfigurationRevision: null, recordId: snapshot.recordId, recordKey, payloadMode: 'plain_json_v1' as const,
            status: 'ok' as const, snapshot, fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs };
        const otherRef = { service, accountId: 'other-organization-context' };
        const otherCredential = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref: otherRef,
            expectedCredentialRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'other-org-a-token' } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId, organizationId: 'org-a' } },
        });
        if (otherCredential.status !== 'written') throw new Error('Expected independent credential create');
        await writeQualifiedProviderAccountUsageRecord({ ...write, expectedCredentialRevision: otherCredential.credentialRevision,
            source: { ref: otherRef, bindingKind: 'account' } });
        await writeQualifiedProviderAccountUsageRecord({ ...write, source: { ref, bindingKind: 'account' } });
        await writeQualifiedProviderAccountUsageRecord({ ...write, source: { ref, bindingKind: 'group_member', groupId: groupRef.groupId,
            groupGeneration: member.group.generation } });
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(3);
        const sameContext = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: created.credentialRevision, expectedConfigurationRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'rotated-org-a-token' } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId, organizationId: 'org-a' } },
        });
        if (sameContext.status !== 'written') throw new Error('Expected same context refresh');
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(3);
        const changed = await mutateQualifiedConnectedServiceCredential({ accountId: account.id, ref,
            expectedCredentialRevision: sameContext.credentialRevision, expectedConfigurationRevision: null, authenticationModeId: 'api-key',
            content: { t: 'plain', v: { token: 'new-context-token' } },
            metadata: { scopes: [], providerIdentity: { accountId: providerAccountId, ...(organizationId ? { organizationId } : {}) } },
        });
        expect(changed.status).toBe('written');
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(1);
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref })).toBeNull();
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref: otherRef }))
            .toMatchObject({ recordId: snapshot.recordId, snapshot: { recordKey: { quotaScopeId: 'org-a' } } });
        if (changed.status !== 'written') throw new Error('Expected context replacement');
        const oldContextWrite = writeQualifiedProviderAccountUsageRecord({ ...write,
            expectedCredentialRevision: changed.credentialRevision, source: { ref, bindingKind: 'account' } });
        if (organizationId) await expect(oldContextWrite).rejects.toMatchObject({ kind: 'mismatch' });
        else await expect(oldContextWrite).resolves.toMatchObject({ sourceOutcome: { status: 'skipped', reason: 'ownership_unproven' } });
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id, recordId: snapshot.recordId } })).toBe(1);
    });

    it.each(['org-b', undefined] as const)('hides retained organization sources when current public context is %s before another observation succeeds', async organizationId => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const { credential, ref } = await createCredential(account.id);
        const row = await db.serviceAccountToken.findFirstOrThrow({ where: { accountId: account.id } });
        const stored = row.metadata;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Expected stored metadata');
        // Retained rows are a real storage boundary; model a previously admitted source alongside a newer public identity.
        await db.serviceAccountToken.update({ where: { id: row.id }, data: { metadata: { ...stored,
            values: { scopes: [], providerIdentity: { accountId: providerAccountId, organizationId: 'org-a' } } } } });
        const recordKey = createProviderAccountUsageRecordKey({ accountSubjectId: providerAccountId, quotaScope: 'organization', quotaScopeId: 'org-a' });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });
        await writeQualifiedProviderAccountUsageRecord({ accountId: account.id, source: { ref, bindingKind: 'account' },
            expectedCredentialRevision: credential.credentialRevision, expectedConfigurationRevision: null,
            recordId: snapshot.recordId, recordKey, payloadMode: 'plain_json_v1', status: 'ok', snapshot,
            fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        await db.serviceAccountToken.update({ where: { id: row.id }, data: { metadata: { ...stored,
            values: { scopes: [], providerIdentity: { accountId: providerAccountId, ...(organizationId ? { organizationId } : {}) } } } } });
        expect(await readExactQualifiedConnectedServiceUsageSource({ accountId: account.id, source: { ref, bindingKind: 'account' } })).toBeNull();
        expect(await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref })).toBeNull();
        expect(await listQualifiedUsageSourcesForRecord({ accountId: account.id, recordId: snapshot.recordId })).toEqual([]);
    });

    it.each(['page', 'witness'] as const)('releases the history transaction before validating captured %s payloads', async kind => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const { credential, ref } = await createCredential(account.id);
        const write = buildUsageWrite(account.id, { credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' }, fetchedAt: Date.now() - 1000, planLabel: 'history' });
        await writeQualifiedProviderAccountUsageRecord(write);
        const witness = await db.providerAccountUsageHistory.findFirstOrThrow({ where: { accountId: account.id, recordId: write.recordId },
            select: { id: true, observedAt: true } });
        let leased = false;
        let parsed = 0;
        let restore = () => {};
        // Observe the actual read connection: SQLite snapshots intentionally
        // bypass Prisma's write-pool $transaction (which begins IMMEDIATE).
        await withSqliteReadSnapshot(async reader => {
            const originalExecute = reader.$executeRawUnsafe;
            const originalFind = reader.providerAccountUsageRecord.findUnique;
            const originalHistoryFind = reader.providerAccountUsageHistory.findMany;
            const execute = originalExecute.bind(reader);
            const find = originalFind.bind(reader.providerAccountUsageRecord);
            const findHistory = originalHistoryFind.bind(reader.providerAccountUsageHistory);
            reader.$executeRawUnsafe = (async (query: string, ...values: unknown[]) => {
                const result = await execute(query, ...values);
                if (query === 'BEGIN DEFERRED;') leased = true;
                if (query === 'ROLLBACK;') leased = false;
                return result;
            }) as typeof reader.$executeRawUnsafe;
            // This boundary observer returns real awaited rows; Prisma's
            // generated delegate additionally advertises PrismaPromise methods.
            const observePayload = (entry: { payload: unknown }) => {
                const payload: unknown = entry.payload;
                Object.defineProperty(entry, 'payload', { get() {
                    parsed++;
                    expect(leased, 'history parsing must not hold a transaction connection').toBe(false);
                    return payload;
                } });
            };
            reader.providerAccountUsageHistory.findMany = (async (args: Parameters<typeof findHistory>[0]) => {
                const rows = await findHistory(args);
                rows.forEach(observePayload);
                return rows;
            }) as unknown as typeof reader.providerAccountUsageHistory.findMany;
            reader.providerAccountUsageRecord.findUnique = (async (args: Parameters<typeof find>[0]) => {
                const row = await find(args);
                if (row && 'history' in row && Array.isArray(row.history)) {
                    row.history.forEach(observePayload);
                }
                return row;
            }) as unknown as typeof reader.providerAccountUsageRecord.findUnique;
            restore = () => {
                reader.$executeRawUnsafe = originalExecute;
                reader.providerAccountUsageRecord.findUnique = originalFind;
                reader.providerAccountUsageHistory.findMany = originalHistoryFind;
            };
        });
        try {
            const result = await readQualifiedProviderAccountUsageHistory({ accountId: account.id, recordId: write.recordId,
                ...(kind === 'page' ? { history: { range: { startAtMs: write.fetchedAt, endAtMs: write.fetchedAt + 1 }, pageSize: 100 } }
                    : { witness: { id: witness.id, observedAtMs: witness.observedAt.getTime() } }) });
            expect(result).toMatchObject({ status: 'resolved', entries: [{ record: { snapshot: write.snapshot } }], nextCursor: null });
            expect(parsed).toBeGreaterThan(0);
        } finally { restore(); }
    });

    it("preserves opaque recovery details through the qualified quota reader", async () => {
        const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" }, select: { id: true } });
        const { credential, ref } = await createCredential(account.id, true);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: "account" }, fetchedAt: Date.now() - 1000,
            planLabel: "encrypted account",
        });
        const { snapshot: _snapshot, ...baseWrite } = write;
        const recoveryCreditDetails = { ciphertext: "opaque-recovery-details" };
        await writeQualifiedProviderAccountUsageRecord({
            ...baseWrite, payloadMode: "sealed_account_scoped_v1",
            sealedPayload: { format: "account_scoped_v1", ciphertext: "opaque-base", recoveryCreditDetails },
        });
        expect(await readQualifiedConnectedAccountQuota({ accountId: account.id, ref }))
            .toMatchObject({ content: { t: "encrypted", c: "opaque-base", recoveryCreditDetails } });
    });

    it("preserves legacy quota recovery details through intrinsic storage and quota projections", async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const serviceId = "anthropic" as const;
        const { ref } = await createCredential(account.id, false, resolveLegacyQualifiedConnectedAccountService(serviceId));
        const fetchedAt = Date.now() - 1000;
        const recoveryCreditDetails = { reset_one: { remainingCount: 2, appliesToProviderLimitIds: ["weekly"] } };
        const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
            v: 1, serviceId, profileId: ref.accountId, fetchedAt, staleAfterMs: 60_000,
            planLabel: "legacy plan", accountLabel: null, source: "provider_api", confidence: "exact",
            recoveryCreditDetails, meters: [],
        });
        await writeLegacyConnectedServiceQuotaCompatibilityRecord({
            accountId: account.id, serviceId, profileId: ref.accountId,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt,
            staleAfterMs: snapshot.staleAfterMs, snapshot,
        });
        const stored = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(stored?.snapshot).toMatchObject({ recoveryCreditDetails });
        expect(await readQualifiedConnectedAccountQuota({ accountId: account.id, ref }))
            .toMatchObject({ content: { t: "plain", v: { recoveryCreditDetails } } });
        expect(projectProviderAccountUsageSnapshotToLegacyQuota({ serviceId, profileId: ref.accountId, snapshot: stored?.snapshot }))
            .toMatchObject({ recoveryCreditDetails });
    });

    it('accepts refresh for a producer-initialized account before its first quota observation', async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: 'plain' },
            select: { id: true },
        });
        const { credential, ref } = await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: 'account' },
            fetchedAt: 0,
            planLabel: 'not observed',
        });
        const snapshot = { ...write.snapshot, state: 'not_loaded' as const, planLabel: null, meters: [] };
        await writeQualifiedProviderAccountUsageRecord({ ...write, status: 'unavailable', snapshot });

        await expect(requestQualifiedConnectedAccountQuotaRefresh({ accountId: account.id, ref }))
            .resolves.toBe('written');
        const stored = await readQualifiedConnectedAccountUsageRecord({ accountId: account.id, ref });
        expect(stored).toMatchObject({ snapshot: { state: 'not_loaded', meters: [] } });
        expect(stored?.refreshRequestedAt).toBeGreaterThan(0);
        await expect(listQualifiedUsageSourcesForRecord({ accountId: account.id, recordId: write.recordId }))
            .resolves.toEqual([{ ref, bindingKind: 'account' }]);
    });

    it("rejects a group binding whose stored structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const groupRef = {
            service,
            groupId: "qualified-group",
        };
        const createdGroup =
            await createQualifiedConnectedAccountGroup({
                accountId: account.id,
                service,
                group: { groupId: groupRef.groupId },
            });
        if (createdGroup.status !== "written") {
            throw new Error("Expected qualified group create");
        }
        const withMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration: createdGroup.group.generation,
                    expectedRuntimeStateRevision:
                        createdGroup.group.runtimeStateRevision,
                },
            });
        if (withMember.status !== "written") {
            throw new Error("Expected qualified group member create");
        }
        const storedGroup =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    groupId: groupRef.groupId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            });
        await db.connectedServiceAuthGroup.update({
            where: { id: storedGroup.id },
            data: {
                servicePluginId: "corrupt.group.identity",
            },
        });

        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: {
                ref,
                bindingKind: "group_member",
                groupId: groupRef.groupId,
                groupGeneration: withMember.group.generation,
            },
            fetchedAt: Date.now(),
            planLabel: "must-not-persist",
        });
        await expect(
            writeQualifiedProviderAccountUsageRecord(write),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(db.providerAccountUsageRecord.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(
            db.connectedServiceAuthGroup.findUniqueOrThrow({
                where: { id: storedGroup.id },
                select: {
                    servicePluginId: true,
                    qualifiedServiceDigest: true,
                    qualifiedGroupDigest: true,
                },
            }),
        ).resolves.toEqual({
            servicePluginId: "corrupt.group.identity",
            qualifiedServiceDigest:
                storedGroup.qualifiedServiceDigest,
            qualifiedGroupDigest:
                storedGroup.qualifiedGroupDigest,
        });
    });

    it("rejects projection from a usage row whose structured tuple disagrees with its retained digests", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: {
                    id: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                serviceLocalId: "corrupt-usage-identity",
            },
        });

        await expect(listQualifiedUsageSourcesForRecord({
            accountId: account.id,
            recordId: write.recordId,
        })).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    serviceLocalId: true,
                    qualifiedServiceDigest: true,
                    qualifiedIdentityDigest: true,
                },
            }),
        ).resolves.toEqual({
            serviceLocalId: "corrupt-usage-identity",
            qualifiedServiceDigest:
                source.qualifiedServiceDigest,
            qualifiedIdentityDigest:
                source.qualifiedIdentityDigest,
        });
    });

    it("finds a valid account source after more than fifty earlier unproven sources", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } = await createCredential(account.id);
        const validWrite = buildUsageWrite(account.id, {
            credentialRevision: credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "valid-after-unproven-sources",
        });
        await writeQualifiedProviderAccountUsageRecord(validWrite);

        const storedCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                id: true,
                servicePluginId: true,
                serviceLocalId: true,
                qualifiedServiceDigest: true,
                connectedAccountId: true,
                qualifiedIdentityDigest: true,
            },
        });
        const laterUpdatedAt = new Date(Date.now() + 60_000);
        for (let index = 0; index < 50; index += 1) {
            const recordId = `unproven-record-${index}`;
            await db.providerAccountUsageRecord.create({
                data: {
                    accountId: account.id,
                    providerId: `unproven-provider-${index}`,
                    recordId,
                    accountSubjectId: `unproven-subject-${index}`,
                    subjectKind: "workspace",
                    quotaScope: "workspace",
                    quotaScopeId: `unproven-scope-${index}`,
                    quotaScopeIdKey: `unproven-scope-${index}`,
                    recordKeyJson: {},
                    payloadMode: "plain_json_v1",
                    status: "ok",
                    updatedAt: laterUpdatedAt,
                },
            });
            await db.connectedServiceUsageSource.create({
                data: {
                    accountId: account.id,
                    servicePluginId: storedCredential.servicePluginId,
                    serviceLocalId: storedCredential.serviceLocalId,
                    qualifiedServiceDigest:
                        storedCredential.qualifiedServiceDigest,
                    connectedAccountId:
                        storedCredential.connectedAccountId,
                    qualifiedIdentityDigest:
                        storedCredential.qualifiedIdentityDigest,
                    credentialId: storedCredential.id,
                    sourceKey: `unproven-source-${index}`,
                    providerAccountUsageRecordId: recordId,
                    bindingKind: "account",
                    updatedAt: laterUpdatedAt,
                },
            });
        }

        await expect(readQualifiedConnectedAccountUsageRecord({
            accountId: account.id,
            ref,
        })).resolves.toMatchObject({ recordId: validWrite.recordId });
    });

    it("rolls back a usage write instead of repairing a corrupt source tuple through its digest lookup", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const firstWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "original",
        });
        await writeQualifiedProviderAccountUsageRecord(
            firstWrite,
        );
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId:
                        firstWrite.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                connectedAccountId:
                    "corrupt-usage-account",
            },
        });
        const replacementWrite = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: firstWrite.fetchedAt + 1,
            planLabel: "must-not-replace",
        });

        await expect(
            writeQualifiedProviderAccountUsageRecord(
                replacementWrite,
            ),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.providerAccountUsageRecord.findUniqueOrThrow({
                where: {
                    accountId_recordId: {
                        accountId: account.id,
                        recordId: firstWrite.recordId,
                    },
                },
                select: { snapshot: true },
            }),
        ).resolves.toMatchObject({
            snapshot: {
                planLabel: "original",
            },
        });
        await expect(
            db.connectedServiceUsageSource.findUniqueOrThrow({
                where: { id: source.id },
                select: {
                    connectedAccountId: true,
                    providerAccountUsageRecordId: true,
                },
            }),
        ).resolves.toEqual({
            connectedAccountId:
                "corrupt-usage-account",
            providerAccountUsageRecordId:
                firstWrite.recordId,
        });
    });

    it("refuses digest-addressed unlink when a matched source has a corrupt structured tuple", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const { credential, ref } =
            await createCredential(account.id);
        const write = buildUsageWrite(account.id, {
            credentialRevision:
                credential.credentialRevision,
            source: { ref, bindingKind: "account" },
            fetchedAt: Date.now(),
            planLabel: "must-remain-linked",
        });
        await writeQualifiedProviderAccountUsageRecord(write);
        const source =
            await db.connectedServiceUsageSource.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    providerAccountUsageRecordId: write.recordId,
                },
                select: { id: true },
            });
        await db.connectedServiceUsageSource.update({
            where: { id: source.id },
            data: {
                servicePluginId:
                    "corrupt.unlink.identity",
            },
        });

        await expect(
            unlinkQualifiedConnectedAccountQuota({
                accountId: account.id,
                ref,
            }),
        ).rejects.toBeInstanceOf(
            ConnectedServiceUsageSourceBindingError,
        );
        await expect(
            db.connectedServiceUsageSource.count({
                where: { id: source.id },
            }),
        ).resolves.toBe(1);
    });
});
