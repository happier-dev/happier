import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { randomUUID } from 'node:crypto';
import { createActionExecutor, getActionSpec, type ActionExecutorDeps, type ApprovalRequest,
    ApprovalRequestSchema, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createServedHomeAccountToken, serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createLegacyAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createDefaultActionExecutor, isApprovalExecutionOriginCurrentForAccountContext } from '@/sync/ops/actions/defaultActionExecutor';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { createSignedAccountContentBinding } from '../../../../../server/sources/testkit/accountEncryption';
import { makeShareEligibleForTest } from '../../../../../server/sources/testkit/shareEligibility.testkit';
import { db } from '../../../../../server/sources/storage/db';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { encryptLegacy } from '../../../../../cli/src/api/encryption';

describe('Machine share approval across device Home profiles (real SQLite)', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r34-machine-approval-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (database) await database.close(); });

    it.each(['creator-profile', 'decider-profile', 'portable-home', 'other-home', 'other-origin'] as const)(
        'replays %s arguments only at the verified Home and continues recipient key preparation', async targetKind => {
        const secret = new Uint8Array(32).fill(31);
        const ownerKey = deriveAccountMachineKeyFromRecoverySecret(secret);
        const ownerKeys = nacl.box.keyPair.fromSecretKey(ownerKey);
        const recipientKeys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(ownerKeys.publicKey), encryptionMode: 'e2ee' } });
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(recipientKeys.publicKey), encryptionMode: 'e2ee' } });
        await makeShareEligibleForTest(owner.id, recipient.id);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodeBase64(encryptLegacy({ host: 'r34-host', platform: 'linux', happyCliVersion: '0.2',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }, secret)),
            dataEncryptionKey: null } });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        artifactsRoutes(app);
        await app.ready();
        // Only network/device credentials are adapted. Requests enter the real strict HTTP
        // routes and disposable SQLite; approval, grant and key lifecycle owners stay real.
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: 'https://r34-machine-approval.test',
            serverIdentityId: 'srv_r34_home', accountId: owner.id, accountMode: 'e2ee',
            credentials: { token: createServedHomeAccountToken(owner.id), secret: encodeBase64(secret) },
            encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }) }],
            route: async request => {
                const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                    headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
                    ...(request.body === undefined ? {} : { payload: request.body }) });
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        const home = homes.homes.home!;
        const account = await captureLazyActionAccountContext(home.id);
        const creatorProfile = 'stack_agent-qa-find-search__id_default';
        const originIdentity = targetKind === 'other-origin' ? 'srv_r34_other' : 'srv_r34_home';
        const input = getActionSpec('machines.access.grant.set').inputSchema.parse({
            serverId: targetKind === 'portable-home' ? 'srv_r34_home' : targetKind === 'decider-profile' ? home.id
                : targetKind === 'other-home' ? 'srv_r34_other' : creatorProfile,
            machineId: machine.id, principal: { kind: 'account', accountId: recipient.id }, level: 'view' });
        const policy = ActionsSettingsV1Schema.parse({ v: 1 });
        let produced: ApprovalRequest | undefined;
        const producerDeps = {
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, policy, context),
            approvalsCreate: async ({ request }) => {
                produced = ApprovalRequestSchema.parse(request);
                const artifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request));
                return { artifactId };
            },
        } satisfies Pick<ActionExecutorDeps, 'isActionApprovalRequired' | 'approvalsCreate'>;
        const producer = createActionExecutor(producerDeps as unknown as ActionExecutorDeps);
        try {
            const proposed = await producer.execute('machines.access.grant.set', input, { surface: 'cli',
                authority: 'account_automation', serverId: creatorProfile, serverIdentityId: originIdentity,
                runtimeAccountId: owner.id, actionRequestId: `share-${machine.id}`, actionCaller: { kind: 'host' } });
            expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
                || typeof proposed.result.artifactId !== 'string') throw new Error('Approval was not created');
            expect(produced).toMatchObject({ v: 2, actionArgs: input,
                executionOriginV1: { serverId: creatorProfile, serverIdentityId: originIdentity } });
            expect(await db.machineAccountGrant.count({ where: { machineId: machine.id } })).toBe(0);
            const original = ApprovalRequestSchema.parse(produced);
            if (original.v !== 2) throw new Error('Approval origin missing');
            const decidingAccount = await captureLazyActionAccountContext(home.id);
            try {
                const resolution = resolveServerProfileForPortableIdentity(originIdentity);
                const current = isApprovalExecutionOriginCurrentForAccountContext({ origin: original.executionOriginV1,
                    accountServerId: decidingAccount.serverId, accountId: decidingAccount.accountId });
                expect({ current, originalAccount: original.executionOriginV1.accountId, decidingAccount: decidingAccount.accountId,
                    expectedAccount: owner.id, originalHome: original.executionOriginV1.serverIdentityId,
                    decidingHome: decidingAccount.serverId, resolution: resolution.kind,
                    resolvedHome: resolution.kind === 'resolved' ? resolution.profile.serverIdentityId : null,
                    accountCurrent: decidingAccount.accountLifetime.isCurrent() }).toMatchObject({
                    current: targetKind !== 'other-origin', originalAccount: owner.id, decidingAccount: owner.id,
                    accountCurrent: true,
                });
            } finally { decidingAccount.dispose(); }
            const decided = await createDefaultActionExecutor().execute('approval.request.decide',
                { artifactId: proposed.result.artifactId, decision: 'approve' }, { surface: 'ui', serverId: home.id });
            if (targetKind === 'other-home' || targetKind === 'other-origin') {
                if (targetKind === 'other-origin') {
                    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: false, errorCode: 'approval_stale' });
                } else {
                    expect(decided).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false,
                        errorCode: 'server_target_mismatch' } } });
                }
                expect(await db.machineAccountGrant.count({ where: { machineId: machine.id } })).toBe(0);
                expect(await db.machineKeyEnvelope.count({ where: { machineId: machine.id } })).toBe(0);
                expect(homes.requests.some(request => request.path.endsWith('/access'))).toBe(false);
                return;
            }
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            expect(await db.machineAccountGrant.findUniqueOrThrow({ where: { machineId_accountId: { machineId: machine.id, accountId: recipient.id } } }))
                .toMatchObject({ accessLevel: 'view', createdByAccountId: owner.id });
            const retained = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            const delivered = await db.machineKeyEnvelope.findFirstOrThrow({ where: { machineId: machine.id, recipientAccountId: recipient.id } });
            const ownerDataKey = openEncryptedDataKeyEnvelopeV1({ envelope: retained.dataEncryptionKey!, recipientSecretKeyOrSeed: ownerKey });
            const recipientDataKey = openEncryptedDataKeyEnvelopeV1({ envelope: delivered.encryptedDataKey, recipientSecretKeyOrSeed: recipientKeys.secretKey });
            expect(recipientDataKey).not.toBeNull();
            expect(recipientDataKey).toEqual(ownerDataKey);
            const stored = await account.fetchArtifact(proposed.result.artifactId);
            if (typeof stored?.body !== 'string') throw new Error('Approval body is unavailable');
            expect(ApprovalRequestSchema.parse(JSON.parse(stored.body))).toMatchObject({
                status: 'executed', actionArgs: input, executionOriginV1: { serverId: creatorProfile } });
        } finally { account.dispose(); await homes.dispose(); await app.close(); }
    });
});
