import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { MACHINE_PLAIN_DATA_KEY_MARKER, MachineAccessGrantsListResponseV1Schema, MachineAccessMutationResultV1Schema, MachineAccessRecipientCensusResponseV1Schema, computeContentPublicKeyFingerprint, encodePlainMachineStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { enqueuePendingMessage, updatePendingRequestedAction, markPendingActivationFailed } from '@/app/session/pending/pendingMessageService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
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
import { invalidateManagedMachineInTx } from '@/app/machines/managed/managedRows';

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
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0', HAPPIER_WEB_LATENCY_TRACE: '1' },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    const headers = (accountId: string) => ({
        'x-test-user-id': accountId,
        'x-happier-account-stored-content-protocol': '4',
    });
    async function fixture() {
        const owner = await db.account.create({ data: { publicKey: `owner-${randomUUID()}`, encryptionMode: 'plain', name: 'Alice', firstName: 'Alice' } });
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

    it('publishes enrollment identity changes to the existing Machine refresh feed in both directions', async () => {
        const { owner, machine } = await fixture();
        const managed = await db.managedMachine.create({ data: {
            homeId: await getOrCreateServerIdentityId(), custodianAccountId: owner.id,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            let cursor = 0;
            for (const enrolledMachineId of [machine.id, null]) {
                await inTx(async tx => {
                    const previous = await tx.managedMachine.findUniqueOrThrow({ where: { id: managed.id } });
                    await tx.managedMachine.update({ where: { id: managed.id }, data: { enrolledMachineId } });
                    await invalidateManagedMachineInTx(tx, previous);
                });
                const changed = await db.accountChange.findFirst({ where: {
                    accountId: owner.id, kind: 'machine', entityId: machine.id,
                } });
                expect(changed?.cursor).toBeGreaterThan(cursor);
                cursor = changed!.cursor;
                const response = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}`, headers: {
                    ...headers(owner.id), accept: 'application/json;happier-machine-projection=host-facts',
                } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ machine: { managedMachineRef: enrolledMachineId === null
                    ? null : { homeId: managed.homeId, managedId: managed.id } } });
            }
        });
    });

    it('acquires recipient-work facts for UI census reads but not API-token bootstrap', async () => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(keys.publicKey) } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            installationId: randomUUID(), metadata: 'encrypted-metadata', daemonState: 'encrypted-state',
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes }) } });
        const phases: string[] = [];
        const previousLogLevel = logger.level;
        logger.level = 'trace';
        const diagnostic = vi.spyOn(logger, 'trace').mockImplementation(record => {
            if (typeof record === 'object' && record !== null && 'phase' in record && typeof record.phase === 'string') {
                phases.push(record.phase);
            }
        });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                phases.length = 0;
                const ui = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(owner.id) });
                expect(ui.statusCode, ui.body).toBe(200);
                expect(ui.json()).toEqual([expect.objectContaining({ id: machine.id, recipientWorkPending: false })]);
                expect(phases.filter(phase => phase === 'db.raw.$queryRawUnsafe')).toHaveLength(1);
                phases.length = 0;
                const bootstrap = await app.inject({ method: 'GET', url: '/v1/machines',
                    headers: { ...headers(owner.id), 'x-test-auth-token-kind': 'api_token' } });
                expect(bootstrap.statusCode, bootstrap.body).toBe(200);
                expect(bootstrap.json()).toEqual([expect.objectContaining({ id: machine.id })]);
                expect(bootstrap.json()[0]).not.toHaveProperty('recipientWorkPending');
                expect(phases.filter(phase => phase === 'db.raw.$queryRawUnsafe')).toHaveLength(0);
            });
        } finally { diagnostic.mockRestore(); logger.level = previousLogLevel; }
    });

    it('reads an owned fleet without a database round trip for every Machine', async () => {
        const { owner, machine } = await fixture();
        // Observe real Prisma operations through the existing diagnostic sink;
        // the HTTP handler, access policy and SQLite reads all remain real.
        const phases: string[] = [];
        const previousLogLevel = logger.level;
        logger.level = 'trace';
        const diagnostic = vi.spyOn(logger, 'trace').mockImplementation(record => {
            if (typeof record === 'object' && record !== null && 'phase' in record
                && typeof record.phase === 'string' && /^db\.[A-Z]/u.test(record.phase)) phases.push(record.phase);
        });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const list = async () => {
                    phases.length = 0;
                    const response = await app.inject({ method: 'GET', url: '/v1/machines?includeRevoked=true', headers: headers(owner.id) });
                    expect(response.statusCode, response.body).toBe(200);
                    return { rows: response.json(), operations: [...phases] };
                };
                const single = await list();
                expect(single.operations.length).toBeGreaterThan(0);
                const extraIds = Array.from({ length: 7 }, () => `machine-${randomUUID()}`);
                await db.machine.createMany({ data: extraIds.map(id => ({ ...machine, id })) });
                const fleet = await list();
                expect(fleet.rows.map((row: { id: string }) => row.id).sort()).toEqual([machine.id, ...extraIds].sort());
                expect(fleet.rows).toEqual(expect.arrayContaining([expect.objectContaining({
                    id: machine.id, metadata: machine.metadata,
                    access: { custodian: { accountId: owner.id, displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                })]));
                expect(fleet.operations.length, JSON.stringify({ single: single.operations, fleet: fleet.operations })).toBeLessThanOrEqual(single.operations.length);
            });
        } finally { diagnostic.mockRestore(); logger.level = previousLogLevel; }
    });

    it('omits revoked owned Machines from listing but preserves offline discovery and exact owner reads', async () => {
        const { owner, recipient, machine } = await fixture();
        const offline = await db.machine.create({ data: { ...machine, id: `machine-${randomUUID()}` } });
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date(), active: false } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const list = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(owner.id) });
            expect(list.statusCode, list.body).toBe(200);
            expect(list.json().map((row: { id: string }) => row.id)).toEqual([offline.id]);
            const retained = await app.inject({ method: 'GET', url: '/v1/machines?includeRevoked=true', headers: headers(owner.id) });
            expect(retained.statusCode, retained.body).toBe(200);
            expect(retained.json().map((row: { id: string }) => row.id).sort()).toEqual([machine.id, offline.id].sort());
            const excluded = await app.inject({ method: 'GET', url: '/v1/machines?includeRevoked=false', headers: headers(owner.id) });
            expect(excluded.json().map((row: { id: string }) => row.id)).toEqual([offline.id]);
            const foreign = await app.inject({ method: 'GET', url: '/v1/machines?includeRevoked=true', headers: headers(recipient.id) });
            expect(foreign.statusCode, foreign.body).toBe(200);
            expect(foreign.json()).toEqual([]);
            const historical = await app.inject({ method: 'GET', url: `/v1/machines/${machine.id}`, headers: headers(owner.id) });
            expect(historical.statusCode, historical.body).toBe(200);
            expect(historical.json()).toMatchObject({ machine: { id: machine.id, active: false, revokedAt: expect.any(Number) } });
        });
    });

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
            for (const level of ['view', 'view', 'admin', 'view'] as const) {
                const response = await app.inject({ method: 'PUT', url: `${base}/access`, headers: headers(owner.id), payload: { principal, level } });
                expect(response.statusCode, response.body).toBe(200);
                expect(MachineAccessMutationResultV1Schema.parse(response.json()), response.body)
                    .toMatchObject({ kind: 'saved', grant: { machineId: machine.id, principal, level }, readiness: 'ready' });
                expect(await db.machineAccountGrant.findUniqueOrThrow({ where: { machineId_accountId: {
                    machineId: machine.id, accountId: recipient.id,
                } } })).toMatchObject({ accessLevel: level });
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

    it.each(['waiting', 'failed'] as const)('reverts a controller grant from a stale Use draft with an active guest binding and %s activation', async status => {
        const { owner, machine: original } = await fixture();
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { ...original, id: randomUUID(),
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey, active: true,
        } });
        const guest = await db.machine.create({ data: { ...controller, id: randomUUID(), installationId: randomUUID(), active: false,
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
        } });
        const managed = await db.managedMachine.create({ data: {
            homeId: await getOrCreateServerIdentityId(), custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, enrolledMachineId: guest.id,
            admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound', creationState: 'active',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
        } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const base = `/v1/machines/${controller.id}/access`;
            const principal = { kind: 'account' as const, accountId: requester.id };
            const write = (machineId: string, level: 'view' | 'admin') => app.inject({ method: 'PUT',
                url: `/v1/machines/${machineId}/access`, headers: headers(owner.id), payload: { principal, level } });
            for (const target of [guest, controller]) expect((await write(target.id, 'view')).json()).toMatchObject({ kind: 'saved' });
            const initial = await app.inject({ method: 'GET', url: base, headers: headers(owner.id) });
            const staleGrant = MachineAccessGrantsListResponseV1Schema.parse(initial.json()).grants[0]!;
            expect(staleGrant).toMatchObject({ principal, level: 'view' });
            // Retain the real client's pre-upgrade draft; the PUT contract has no read revision.
            const staleDraft = { principal: staleGrant.principal, level: staleGrant.level };
            for (const target of [guest, controller]) expect((await write(target.id, 'admin')).json()).toMatchObject({ kind: 'saved' });
            const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: false } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id, sessionId: session.id,
                machineId: guest.id, data: 'fixture-key' }))).toMatchObject({ ok: true });
            const input = { actorUserId: requester.id, authentication: createPresentUserSessionAccessAuthentication(), sessionId: session.id,
                localId: randomUUID(), targetMachineId: guest.id, requestedAction: { v: 1, kind: 'enqueue' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained input' } } } } as const;
            expect(await enqueuePendingMessage(input)).toMatchObject({ ok: true });
            expect(await updatePendingRequestedAction({ ...input, resumeWhenAvailable: true })).toMatchObject({ ok: true });
            const waiting = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            expect(waiting.pendingActivationStatus).toBe('waiting');
            expect(waiting.pendingActivationManagedTarget).toMatchObject({ managedId: managed.id, enrolledMachineId: guest.id,
                controller: { machineId: controller.id, installationId: controller.installationId } });
            if (status === 'failed') expect(await markPendingActivationFailed({ actorUserId: requester.id, sessionId: session.id,
                requestId: input.localId, requestedAt: waiting.pendingActivationRequestedAt!.getTime(), failureCode: 'managed_start_failed' }))
                .toMatchObject({ ok: true, didFail: true });
            const revert = () => app.inject({ method: 'PUT', url: base, headers: headers(owner.id), payload: staleDraft });
            const response = await revert();
            expect(response.statusCode, response.body).toBe(200);
            expect(MachineAccessMutationResultV1Schema.parse(response.json())).toMatchObject({ kind: 'saved', grant: { level: 'view' }, readiness: 'ready' });
            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: managed.id } })).toMatchObject({ enrolledMachineId: guest.id, creationState: 'active' });
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 1, pendingActivationStatus: status });
            expect(await db.accessKey.count({ where: { sessionId: session.id, machineId: guest.id } })).toBe(1);
            if (status !== 'failed') return;

            // Diagnostic fallback only: a real SQLite constraint exception is NOT
            // claimed as the historical 500's cause. Prove the real route logs it safely.
            expect((await write(controller.id, 'admin')).json()).toMatchObject({ kind: 'saved' });
            const records: Record<string, unknown>[] = [];
            const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
            const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
            try {
                await db.$executeRawUnsafe(`CREATE TRIGGER qb106_reject_downgrade BEFORE UPDATE ON MachineAccountGrant
                    WHEN NEW.accessLevel = 'view' BEGIN SELECT RAISE(ABORT, 'private-fixture-failure'); END`);
                const failed = await revert();
                expect(failed.statusCode).toBe(500);
                expect(failed.json()).toMatchObject({ code: 'internal_error' });
                expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ module: 'fastify-error',
                    httpRequestId: expect.any(String), errorClass: 'PrismaClientKnownRequestError', errorCode: 'P2003',
                    stackFrames: expect.arrayContaining([expect.objectContaining({ file: expect.stringContaining('machineAccess.ts'), line: expect.any(Number) })]),
                })]));
                expect(JSON.stringify(records)).not.toContain('private-fixture-failure');
                const committed = await app.inject({ method: 'GET', url: base, headers: headers(owner.id) });
                expect(MachineAccessGrantsListResponseV1Schema.parse(committed.json()).grants[0]?.level).toBe('admin');
                await db.$executeRawUnsafe('DROP TRIGGER qb106_reject_downgrade');
                expect((await revert()).json()).toMatchObject({ kind: 'saved', grant: { level: 'view' } });
            } finally {
                sink.mockRestore();
                await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS qb106_reject_downgrade');
            }
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
            if (envelopeState === 'absent') {
                const discovery = await app.inject({ method: 'GET', url: '/v1/machines?includeRevoked=true', headers: headers(owner.id) });
                expect(discovery.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: machine.id,
                    recipientWorkPending: true, recipientWorkCursor: expect.any(Number) })]));
                const selected = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(owner.id),
                    payload: { machineIds: [machine.id] } });
                expect(selected.json()).toMatchObject({ results: [{ status: 'found', machine: { recipientWorkPending: true } }] });
            }
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
            expect(ready.json().machine).not.toHaveProperty('recipientWorkPending');
            const settled = await app.inject({ method: 'GET', url: base, headers: headers(owner.id) });
            expect(settled.json()).toMatchObject({ machine: { recipientWorkPending: false, recipientWorkCursor: expect.any(Number) } });
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
            const pendingList = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(recipient.id) });
            expect(pendingList.statusCode, pendingList.body).toBe(200);
            expect(pendingList.json()).toEqual([pending.json().machine]);
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
            const readyList = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(recipient.id) });
            expect(readyList.statusCode, readyList.body).toBe(200);
            expect(readyList.json()).toEqual([ready.json().machine]);
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
            const staleList = await app.inject({ method: 'GET', url: '/v1/machines', headers: headers(recipient.id) });
            expect(staleList.statusCode, staleList.body).toBe(200);
            expect(staleList.json()).toEqual([stale.json().machine]);
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
