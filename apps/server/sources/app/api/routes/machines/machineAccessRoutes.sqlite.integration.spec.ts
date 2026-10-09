import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { MACHINE_PLAIN_DATA_KEY_MARKER, MachineAccessGrantsListResponseV1Schema, MachineAccessRecipientCensusResponseV1Schema, computeContentPublicKeyFingerprint, encodePlainMachineStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { encryptWithDataKey, decryptWithDataKey } from '../../../../../../cli/src/api/encryption';
import { prepareMachineAccessKeyEnvelopes } from '../../../../../../cli/src/api/machineAccessGrantEnvelopeHost';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
    computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
} from '@happier-dev/protocol/actions';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { machinesRoutes } from './machinesRoutes';

vi.mock('axios', async importOriginal => {
    const actual = await importOriginal<typeof import('axios')>();
    // HTTP dispatch enters actual Fastify routes/SQLite; no preparation or access logic is mocked.
    return { ...actual, default: { ...actual.default, get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

describe('Machine accessible discovery and access HTTP (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-machine-access-http-',
            initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    const headers = (accountId: string) => ({
        'x-test-user-id': accountId,
        'x-happier-account-stored-content-protocol': '4',
    });
    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}`, encryptionMode: 'plain', firstName: 'Alice' } });
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const other = await db.account.create({ data: { publicKey: `other-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`, accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'workstation', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: `installation-${randomUUID()}`,
        } });
        return { owner, recipient, other, machine };
    }

    it('exposes the current owner audience through the real access route', async () => {
        const { owner, machine } = await fixture();
        let routeError: Error | undefined;
        await withAuthenticatedTestApp((app) => {
            app.addHook('onError', async (_request: FastifyRequest, _reply: FastifyReply, error: FastifyError) => { routeError = error; });
            machinesRoutes(app);
        }, async (app) => {
            const response = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/access`, headers: headers(owner.id) });
            expect(response.statusCode, routeError?.stack ?? response.body).toBe(200);
            expect(MachineAccessGrantsListResponseV1Schema.parse(response.json())).toMatchObject({
                machineId: machine.id, canManage: true, grants: [], access: { role: 'manage', resourceMode: 'plain' },
            });
        });
    });

    it('sets and removes exact grants, discovers recipients, conceals unrelated reads and stamps leave identity', async () => {
        const { owner, recipient, other, machine } = await fixture();
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const base = `/v1/machines/${machine.id}`;
            const principal = { kind: 'account', accountId: recipient.id };
            for (let attempt = 0; attempt < 2; attempt++) {
                const response = await app.inject({ method: 'PUT', url: `${base}/access`, headers: headers(owner.id), payload: { principal, level: 'view' } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json(), response.body).toMatchObject({ kind: 'saved', readiness: 'ready' });
            }
            const recipientAccess = await app.inject({ method: 'GET', url: `${base}/access`, headers: headers(recipient.id) });
            expect(recipientAccess.statusCode, recipientAccess.body).toBe(200);
            expect(recipientAccess.json()).toMatchObject({ canManage: false, grants: [], ownDirectGrant: true });
            const list = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(recipient.id) });
            expect(list.statusCode, list.body).toBe(200);
            expect(list.json()).toContainEqual(expect.objectContaining({ id: machine.id, access: { custodian: { accountId: owner.id, displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }));
            const detail = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ machine: { id: machine.id, dataEncryptionKey: null } });
            const absent = await app.inject({ method: 'GET', url: base, headers: headers(other.id) });
            expect(absent.statusCode).toBe(404);
            const denied = await app.inject({ method: 'PUT', url: `${base}/access`, headers: headers(recipient.id), payload: { principal: { kind: 'account', accountId: other.id }, level: 'admin' } });
            expect(denied.json()).toEqual({ kind: 'refused', code: 'access_denied' });
            const forged = await app.inject({ method: 'DELETE', url: `${base}/access`, headers: headers(recipient.id), payload: { principal: { kind: 'account', accountId: owner.id }, leave: true } });
            expect(forged.statusCode).toBe(400);
            const left = await app.inject({ method: 'DELETE', url: `${base}/access`, headers: headers(recipient.id), payload: {} });
            expect(left.statusCode, left.body).toBe(200);
            expect(left.json()).toMatchObject({ kind: 'left', effectiveAccess: 'none' });
            const revoked = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(revoked.statusCode).toBe(404);
        });
    });

    it.each(['absent', 'malformed-present'] as const)('first share of predecessor %s owner material uses actual client preparation and real routes', async envelopeState => {
        // Actual ../0.2 factory basis f2dd8f01185784676b639cec5cf8a5ed79973301:
        // client/encryptionKey.ts#resolveMachineEncryptionContext + api.ts registration.
        // Captured by executing that factory and its encryptLegacy serializer with
        // secret=21*32 and the edited objects below; no current factory produced these bytes.
        const predecessorMetadata = 'LGwj+2OZUgTFSNE0XwZuM6nr3ZIrIZYFjPoqt7APLvxjr4VdACdgCgmQOuF5+WZE8mTKZ7x7hvmP8gq7jFGOwSfS/pu3Rk7MBTktTarigh7iimerlHdrpgjuPkkTsxG/egpFEHqJKmHuvLn6Z5dHAHexOSL6zcnVVSmGQlv8Cd5o9mvjVVLWc33CuDXwl0a5Ll6hBotnkIDju9BnXEQr1pdVvCnDmNUDmZA2948QAmGEKe81TmGtgvGnLXycff3cto2qXErTpDZ058TByuX3XmU/HOC/cAzgt2WkAa6e3eRT3JEyz8A3UqvnovzZgpGIfKiZwuLsndtU+w8mCPEoNNwMG1WUsVKqd0IYLN7chu0cEQNAppZuUd9rE64n';
        const predecessorState = '14cnqX/ggtSHjD7iqiDsO7i5Hhm7GreLcs34Md0oRQeflMjEkRWAAsNJslOSrF63VB10zPV0ATiUYsbMkWHcHp8Bgfgui5auJ17aNrlY4yWr6eYUFlj83X1u2+Ex3D+WdgZrkT2gdZr2hXj7jsPCQAExMrLw5mY+FlM1JAqqRlP23e+oKAhBSp1mSuUgj35VL7rQ';
        const secret = new Uint8Array(32).fill(21);
        const ownerKey = deriveAccountMachineKeyFromRecoverySecret(secret);
        const ownerKeys = tweetnacl.box.keyPair.fromSecretKey(ownerKey);
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(ownerKeys.publicKey), encryptionMode: 'e2ee' } });
        const recipientKeys = tweetnacl.box.keyPair();
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(recipientKeys.publicKey), encryptionMode: 'e2ee' } });
        const editedMetadata = { host: 'workstation', platform: 'linux', happyCliVersion: '0.2.0', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier', displayName: 'Edited workstation', username: 'alice' };
        const editedState = { status: 'running', pid: 42, httpPort: 4321 };
        const machine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`, accountId: owner.id,
            metadata: predecessorMetadata, metadataVersion: 5,
            daemonState: predecessorState, daemonStateVersion: 7,
            dataEncryptionKey: envelopeState === 'absent' ? null : new Uint8Array([0, 1, 2]),
            installationId: `installation-${randomUUID()}`,
        } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const base = `/v1/machines/${machine.id}`;
            if (envelopeState === 'absent') {
                const grant = await app.inject({ method: 'PUT', url: `${base}/access`, headers: headers(owner.id), payload: { principal: { kind: 'account', accountId: recipient.id }, level: 'view' } });
                expect(grant.json()).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
            }
            const before = await app.inject({ method: 'GET', url: `${base}/data-key-envelopes`, headers: headers(owner.id) });
            expect(before.json()).toMatchObject({ kind: 'refused' });
            const paths: string[] = [];
            const request = async (method: 'GET' | 'POST' | 'PATCH', url: unknown, body?: unknown) => {
                const path = new URL(String(url)).pathname + new URL(String(url)).search;
                paths.push(`${method} ${path}`);
                if (path === '/v1/account/encryption') {
                    const persisted = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
                    return { status: 200, data: { mode: persisted.encryptionMode, updatedAt: 1 } };
                }
                const response = await app.inject({ method, url: path, headers: headers(owner.id), ...(body === undefined ? {} : { payload: body }) });
                return { status: response.statusCode, data: response.json() };
            };
            vi.mocked(axios.get).mockImplementation(url => request('GET', url));
            vi.mocked(axios.post).mockImplementation((url, body) => request('POST', url, body));
            vi.mocked(axios.patch).mockImplementation((url, body) => request('PATCH', url, body));
            const token = `header.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.signature`;
            const result = await prepareMachineAccessKeyEnvelopes({ credentials: { token, encryption: { type: 'legacy', secret } }, serverHttpBaseUrl: 'https://owner-home.test', serverId: 'owner-home', machineId: machine.id });
            const retained = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            if (envelopeState === 'malformed-present') {
                expect(result).toMatchObject({ kind: 'unavailable' });
                expect(retained).toEqual(machine);
                expect(await db.machineKeyEnvelope.count({ where: { machineId: machine.id } })).toBe(0);
                expect(paths.some(path => path.startsWith('POST ') || path.startsWith('PATCH '))).toBe(false);
                return;
            }
            expect(result).toEqual({ kind: 'prepared' });
            const independentKey = openEncryptedDataKeyEnvelopeV1({ envelope: retained.dataEncryptionKey!, recipientSecretKeyOrSeed: ownerKey });
            expect(independentKey).not.toBeNull();
            expect(independentKey).not.toEqual(secret);
            expect(independentKey).not.toEqual(ownerKey);
            expect(decryptWithDataKey(privacyKit.decodeBase64(retained.metadata), independentKey!)).toEqual(editedMetadata);
            expect(decryptWithDataKey(privacyKit.decodeBase64(retained.daemonState!), independentKey!)).toEqual(editedState);
            expect(retained).toMatchObject({ metadataVersion: 6, daemonStateVersion: 8 });
            const ready = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(ready.json().machine.access.accessState).toBe('ready');
            const recipientKey = openEncryptedDataKeyEnvelopeV1({ envelope: privacyKit.decodeBase64(ready.json().machine.dataEncryptionKey), recipientSecretKeyOrSeed: recipientKeys.secretKey });
            expect(recipientKey).toEqual(independentKey);
            expect(decryptWithDataKey(privacyKit.decodeBase64(ready.json().machine.metadata), recipientKey!)).toEqual(editedMetadata);
            expect(decryptWithDataKey(privacyKit.decodeBase64(ready.json().machine.daemonState), recipientKey!)).toEqual(editedState);
        });
    });

    it('retains legacy owner content while withholding pending recipients and their unrelated audience census', async () => {
        const ownerKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(ownerKeys.publicKey), encryptionMode: 'e2ee' } });
        const recipientKeys = tweetnacl.box.keyPair();
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(recipientKeys.publicKey), encryptionMode: 'e2ee' } });
        const dataKey = tweetnacl.randomBytes(32);
        const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes });
        const machine = await db.machine.create({ data: {
            id: `machine-${randomUUID()}`, accountId: owner.id,
            metadata: privacyKit.encodeBase64(encryptWithDataKey({ host: 'workstation', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' }, dataKey)),
            daemonState: privacyKit.encodeBase64(encryptWithDataKey({ status: 'running' }, dataKey)), dataEncryptionKey: new Uint8Array(envelope),
            installationId: `installation-${randomUUID()}`,
        } });
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const base = `/v1/machines/${machine.id}`;
            const saved = await app.inject({ method: 'PUT', url: `${base}/access`, headers: headers(owner.id), payload: { principal: { kind: 'account', accountId: recipient.id }, level: 'view' } });
            expect(saved.statusCode, saved.body).toBe(200);
            expect(saved.json()).toMatchObject({ kind: 'saved', readiness: 'key_pending' });
            const own = await app.inject({ method: 'GET', url: base, headers: headers(owner.id) });
            expect(own.statusCode, own.body).toBe(200);
            expect(own.json()).toMatchObject({ machine: { metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: privacyKit.encodeBase64(envelope) } });
            const pending = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(pending.statusCode, pending.body).toBe(200);
            expect(pending.json()).toMatchObject({ machine: { metadata: null, daemonState: null, dataEncryptionKey: null, access: { accessState: 'key_pending' } } });
            expect(pending.json().machine.keyBasis).toEqual({ dataEncryptionKey: privacyKit.encodeBase64(envelope), metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion });
            const deniedCensus = await app.inject({ method: 'GET', url: `${base}/data-key-envelopes`, headers: headers(recipient.id) });
            expect(deniedCensus.json()).toEqual({ kind: 'refused', code: 'access_denied' });

            const ownerCensusResponse = await app.inject({ method: 'GET', url: `${base}/data-key-envelopes`, headers: headers(owner.id) });
            expect(ownerCensusResponse.statusCode, ownerCensusResponse.body).toBe(200);
            const census = MachineAccessRecipientCensusResponseV1Schema.parse(ownerCensusResponse.json());
            const recipientEnvelope = privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes }));
            const committed = await app.inject({ method: 'PATCH', url: `${base}/data-key-envelopes`, headers: headers(owner.id), payload: {
                expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint,
                expectedCallerDataEncryptionKey: census.callerDataEncryptionKey,
                expectedMetadataVersion: census.content.metadataVersion,
                expectedDaemonStateVersion: census.content.daemonStateVersion,
                recipientKeyEnvelopes: [{ recipientAccountId: recipient.id, encryptedDataKey: recipientEnvelope, recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKeys.publicKey) }],
            } });
            expect(committed.statusCode, committed.body).toBe(200);
            expect(committed.json()).toEqual({ appliedRecipientAccountIds: [recipient.id], skippedRecipientAccountIds: [] });
            const ready = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(ready.statusCode, ready.body).toBe(200);
            expect(ready.json()).toMatchObject({ machine: {
                metadata: machine.metadata, daemonState: machine.daemonState,
                dataEncryptionKey: recipientEnvelope,
                access: { resourceMode: 'e2ee', accessState: 'ready' },
            } });
            expect(ready.json().machine.keyBasis).toEqual({ dataEncryptionKey: privacyKit.encodeBase64(envelope), metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion });
            expect(ready.json().machine.dataEncryptionKey).not.toBe(ready.json().machine.keyBasis.dataEncryptionKey);
            const bootstrap = await app.inject({ method: 'GET', url: '/v1/machines', headers: { ...headers(recipient.id), 'x-test-auth-token-kind': 'api_token' } });
            expect(bootstrap.statusCode, bootstrap.body).toBe(200);
            expect(bootstrap.json()).toEqual([expect.objectContaining({
                id: machine.id, installationId: machine.installationId, dataEncryptionKey: recipientEnvelope,
                access: { custodian: { accountId: owner.id, displayName: expect.any(String) }, role: 'use', resourceMode: 'e2ee', accessState: 'ready' },
            })]);
            expect(bootstrap.json()[0]).not.toHaveProperty('metadata');
            expect(bootstrap.json()[0]).not.toHaveProperty('daemonState');
            expect(bootstrap.body).not.toContain(privacyKit.encodeBase64(envelope));
            await db.account.update({ where: { id: recipient.id }, data: createSignedAccountContentBinding() });
            const stale = await app.inject({ method: 'GET', url: base, headers: headers(recipient.id) });
            expect(stale.statusCode, stale.body).toBe(200);
            expect(stale.json()).toMatchObject({ machine: { metadata: null, daemonState: null, dataEncryptionKey: null, access: { accessState: 'key_pending' } } });
            expect(stale.json().machine.keyBasis).toEqual({ dataEncryptionKey: privacyKit.encodeBase64(envelope), metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion });
        });
    });

    it('admits an exact signed grant-set key continuation from another installation and rechecks current resource authority', async () => {
        const { owner, recipient, machine } = await fixture();
        const installationKeys = tweetnacl.sign.keyPair();
        const executor = await db.machine.create({ data: {
            id: `executor-${randomUUID()}`, accountId: owner.id,
            metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: machine.dataEncryptionKey,
            installationId: `installation-${randomUUID()}`, installationPublicKey: new Uint8Array(installationKeys.publicKey),
        } });
        const issued = await auth.createApiToken({ accountId: owner.id, tokenId: randomUUID(), label: 'Machine access continuation' });
        const principal = (await auth.verifyTokenForRoute(issued.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Missing authenticated fixture principal');
        const target = { kind: 'machine' as const, machineId: executor.id };
        const requestId = randomUUID();
        const serverIdentityId = await getOrCreateServerIdentityId();
        const authorization = await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId, accountId: principal.accountId,
            principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
            machineId: executor.id, actionId: 'machines.access.grant.set', requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId, target, input: { serverId: serverIdentityId, machineId: machine.id, principal: { kind: 'account', accountId: recipient.id }, level: 'view' },
            }), target,
        });
        const path = `/v1/machines/${machine.id}/data-key-envelopes?limit=1`;
        const signedHeaders = {
            'x-happier-account-stored-content-protocol': '4',
            [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
            [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.access.grant.set',
            [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
            [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                authorizationToken: authorization.token, effectActionId: 'machines.access.grant.set', target,
                installationId: executor.installationId!, requestId, method: 'GET', path, privateKey: installationKeys.secretKey,
            }),
        };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        machinesRoutes(app);
        await app.ready();
        try {
            const admitted = await app.inject({ method: 'GET', url: path, headers: signedHeaders });
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ machineId: machine.id, encryptionMode: 'plain', callerDataEncryptionKey: null });
            const substitutedQuery = await app.inject({ method: 'GET', url: path.replace('limit=1', 'limit=2'), headers: signedHeaders });
            expect(substitutedQuery.statusCode, substitutedQuery.body).toBe(401);
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            const noLongerAdmitted = await app.inject({ method: 'GET', url: path, headers: signedHeaders });
            expect(noLongerAdmitted.statusCode, noLongerAdmitted.body).toBe(200);
            expect(noLongerAdmitted.json()).toEqual({ kind: 'refused', code: 'access_denied' });
        } finally { await app.close(); }
    });

    it('does not promote a signed foreign Manager to original-custodian content-key conversion authority', async () => {
        const { owner, other: manager, machine } = await fixture();
        await withAuthenticatedTestApp(machinesRoutes, async (app) => {
            const grant = await app.inject({ method: 'PUT', url: `/v1/machines/${machine.id}/access`, headers: headers(owner.id), payload: {
                principal: { kind: 'account', accountId: manager.id }, level: 'admin',
            } });
            expect(grant.statusCode, grant.body).toBe(200);
            expect(grant.json(), grant.body).toMatchObject({ kind: 'saved', readiness: 'ready' });
            const access = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/access`, headers: headers(manager.id) });
            expect(access.statusCode, access.body).toBe(200);
            expect(access.json()).toMatchObject({ canManage: true, access: { role: 'manage', accessState: 'ready' } });
        });
        const installationKeys = tweetnacl.sign.keyPair();
        const executor = await db.machine.create({ data: {
            id: `executor-${randomUUID()}`, accountId: manager.id,
            metadata: machine.metadata, daemonState: machine.daemonState, dataEncryptionKey: machine.dataEncryptionKey,
            installationId: `installation-${randomUUID()}`, installationPublicKey: new Uint8Array(installationKeys.publicKey),
        } });
        const issued = await auth.createApiToken({ accountId: manager.id, tokenId: randomUUID(), label: 'Foreign Machine Manager continuation' });
        const principal = (await auth.verifyTokenForRoute(issued.token))?.apiTokenPrincipal;
        if (!principal) throw new Error('Missing authenticated fixture principal');
        const target = { kind: 'machine' as const, machineId: executor.id };
        const requestId = randomUUID();
        const serverIdentityId = await getOrCreateServerIdentityId();
        const authorization = await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId, accountId: principal.accountId,
            principalId: principal.principalId, credentialId: principal.credentialId, grant: principal.grant,
            machineId: executor.id, actionId: 'machines.access.grant.set', requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({
                v: 1, requestId, target, input: { serverId: serverIdentityId, machineId: machine.id, principal: { kind: 'account', accountId: manager.id }, level: 'admin' },
            }), target,
        });
        const path = `/v1/machines/${machine.id}/content-key/transition`;
        const wrappingKey = tweetnacl.box.keyPair();
        const dataKey = tweetnacl.randomBytes(32);
        const body = {
            machineId: machine.id,
            expected: { dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: machine.metadataVersion, daemonStateVersion: machine.daemonStateVersion },
            next: {
                dataEncryptionKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: wrappingKey.publicKey, randomBytes: tweetnacl.randomBytes })),
                metadata: privacyKit.encodeBase64(encryptWithDataKey({ host: 'converted' }, dataKey)), daemonState: null,
            },
        };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app);
        machinesRoutes(app);
        await app.ready();
        try {
            const response = await app.inject({ method: 'POST', url: path, payload: body, headers: {
                'x-happier-account-stored-content-protocol': '4',
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.access.grant.set',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'machines.access.grant.set', target,
                    installationId: executor.installationId!, requestId, method: 'POST', path, body, privateKey: installationKeys.secretKey,
                }),
            } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ kind: 'refused', code: 'forbidden' });
            const unchanged = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
            expect(unchanged).toMatchObject({ accountId: owner.id, metadata: machine.metadata, metadataVersion: machine.metadataVersion, daemonState: machine.daemonState, daemonStateVersion: machine.daemonStateVersion });
            expect(unchanged.dataEncryptionKey).toEqual(machine.dataEncryptionKey);
        } finally { await app.close(); }
    });
});
