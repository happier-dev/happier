import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, encodePlainMachineStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { MachineAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerMachineAccessRoutes } from '@/app/api/routes/machines/machineAccessRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { acquireMachineAccessPublicationLocksInTx, readMachineRecipientCensusInTx, resolveMachineAdmissionInTx, resolveMachineAdmissionsInTx } from './machineAccess';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { readArtifactRecipientCensusInTx, commitArtifactRecipientKeyEnvelopesInTx, readArtifactHeaderForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { removeTeamMemberForActorInTx } from '@/app/teams/memberships/memberAdministration';

async function fixture() {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: {
        id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
        metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        daemonState: encodePlainMachineStoredContent({ status: 'offline' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
    } });
    await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: recipient.id,
        accessLevel: 'view', createdByAccountId: owner.id } });
    return { owner, recipient, machine };
}

/** Interleave only at the Prisma transport; all access decisions and SQL remain real. */
function beforeAdmissionFence(interleave: () => Promise<void>) {
    const original = db.$transaction;
    let advanced = false;
    db.$transaction = new Proxy(original, {
        apply(target, thisArg, args) {
            const [run, options] = args;
            return Reflect.apply(target, thisArg, [async (tx: Tx) => run(new Proxy(tx, {
                get(transaction, property, receiver) {
                    const value = Reflect.get(transaction, property, receiver);
                    if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(transaction) : value;
                    return async (...queryArgs: unknown[]) => {
                        const sql = typeof queryArgs[0] === 'string' ? queryArgs[0] : '';
                        // Entry admission precedes resource/recipient decisions; NO KEY UPDATE
                        // now belongs to terminal cursor publication, after those decisions.
                        if (!advanced && sql.includes('Account') && sql.includes('FOR KEY SHARE')) {
                            advanced = true;
                            await interleave();
                        }
                        return Reflect.apply(value, transaction, queryArgs);
                    };
                },
            })), options]);
        },
    });
    return () => {
        db.$transaction = original;
        expect(advanced, 'the interleave must reach the real Account admission boundary').toBe(true);
    };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine access publication (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('acquires its audience once at admission and reuses it for canonical publication', async () => {
        const f = await fixture();
        let reads: readonly string[] = [];
        let audienceQueries = 0;
        await inTx(async tx => {
            const observed = observePrismaReads(tx, ['machine']);
            reads = observed.reads;
            // Count the same audience acquisition before and after the canonical
            // narrow membership projection replaces the full model read.
            const traced = new Proxy(observed.tx, { get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== '$queryRawUnsafe') return typeof value === 'function' ? value.bind(target) : value;
                return async (...args: unknown[]) => {
                    if (typeof args[0] === 'string' && /WITH(?: RECURSIVE)? selected AS/u.test(args[0])) audienceQueries++;
                    return Reflect.apply(value, target, args);
                };
            } });
            await acquireMachineAccessPublicationLocksInTx(traced, f.machine.id);
            await markAccountChanged(traced, { accountId: f.owner.id, kind: 'machine', entityId: f.machine.id });
        });
        expect(reads.length + audienceQueries).toBe(1);
        expect(await db.accountChange.findFirst({ where: {
            accountId: f.owner.id, kind: 'machine', entityId: f.machine.id,
        } })).toMatchObject({ entityId: f.machine.id });
    });

    it('skips a Resource recipient whose Team removal committed between census and PATCH', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const team = await db.team.create({ data: { name: 'Resource recipient removal' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: recipient.id, role: 'member' } });
        const key = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode('opaque header'), body: new TextEncoder().encode('opaque body'),
            dataEncryptionKey: new Uint8Array(wrap(owner.contentPublicKey!)) } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const actor = { actorAccountId: owner.id, artifactId: artifact.id };
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, actor));
        if (!census.ok) throw new Error(census.error);
        const prepared = census.value.recipients.find(row => row.recipientAccountId === recipient.id);
        expect(prepared?.contentPublicKeyFingerprint).toBe(computeContentPublicKeyFingerprint(recipient.contentPublicKey!));
        expect(await inTx(tx => removeTeamMemberForActorInTx(tx, { teamId: team.id,
            actorAccountId: owner.id, membershipId: membership.id }))).toMatchObject({ ok: true });
        const committed = await inTx(tx => commitArtifactRecipientKeyEnvelopesInTx(tx, { ...actor,
            expectedDataEncryptionKey: encodeBase64(artifact.dataEncryptionKey), recipientKeyEnvelopes: [{
                recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(wrap(recipient.contentPublicKey!)),
                recipientContentPublicKeyFingerprint: prepared!.contentPublicKeyFingerprint!,
            }],
        }));
        expect(committed).toEqual({ ok: true, value: { appliedRecipientAccountIds: [], skippedRecipientAccountIds: [recipient.id] } });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id, recipientAccountId: recipient.id } })).toBe(0);
        expect(await inTx(tx => readArtifactHeaderForCallerInTx(tx, { ...actor, actorAccountId: recipient.id })))
            .toEqual({ ok: false, error: 'artifact_not_found' });
    });

    it('admits owned Machines without waiting for the unrelated foreign-grant graph', async () => {
        const f = await fixture();
        let finished = false;
        let finishedBeforeGrantRelease = false;
        let admissions: Promise<unknown> | undefined;
        try {
            // A real database boundary makes an unnecessary grant read observable
            // without an elapsed-time threshold or an internal policy mock.
            await db.$transaction(async holder => {
                await holder.$executeRawUnsafe('LOCK TABLE "MachineGrant" IN ACCESS EXCLUSIVE MODE');
                const [{ pid }] = await holder.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                admissions = Promise.all([
                    inTx(tx => resolveMachineAdmissionInTx(tx, { actorAccountId: f.owner.id, machineId: f.machine.id })),
                    inTx(tx => resolveMachineAdmissionsInTx(tx, { actorAccountId: f.owner.id, machineIds: [f.machine.id] })),
                ]).then(([point, batch]) => {
                    expect(point).toMatchObject({ kind: 'admitted', machineId: f.machine.id, role: 'manage' });
                    expect(batch.get(f.machine.id)).toEqual(point);
                }).finally(() => { finished = true; });
                void admissions.catch(() => undefined);
                while (!finished) {
                    const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                            WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                    if (blocked) break;
                }
                finishedBeforeGrantRelease = finished;
            });
            await admissions;
            expect(finishedBeforeGrantRelease).toBe(true);
        } finally {
            await admissions;
            await db.machine.delete({ where: { id: f.machine.id } });
            await db.account.deleteMany({ where: { id: { in: [f.owner.id, f.recipient.id] } } });
        }
    });

    it.each(['upgrade', 'revoke'] as const)('%s commits under continuous short recipient publications', async phase => {
        const f = await fixture();
        // Exercise the default transaction owner policy, independent of inherited operator settings.
        for (const prefix of ['HAPPIER', 'HAPPY']) for (const key of ['MAX_RETRIES', 'RETRY_BASE_DELAY_MS',
            'RETRY_MAX_DELAY_MS', 'RETRY_JITTER_FACTOR', 'TOTAL_RETRY_BUDGET_MS', 'TIMEOUT_MS', 'MAX_WAIT_MS']) {
            vi.stubEnv(`${prefix}_DB_TX_${key}`, undefined);
        }
        let stop = false;
        let publications = 0;
        let maximumHoldMs = 0;
        let ready!: () => void;
        const started = new Promise<void>(resolve => { ready = resolve; });
        const began = Date.now();
        // QB67's three independent short holders, without coordination with write attempts.
        const publishers = Promise.allSettled(Array.from({ length: 3 }, (_, index) => (async () => {
            while (!stop) await inTx(async tx => {
                await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${f.recipient.id} FOR NO KEY UPDATE`;
                const acquired = Date.now();
                await markAccountChanged(tx, { accountId: f.recipient.id, kind: 'account', entityId: `hot-${index}` });
                await tx.$executeRaw`SELECT pg_sleep(0.02)`;
                publications++;
                maximumHoldMs = Math.max(maximumHoldMs, Date.now() - acquired);
                if (publications === 15) ready();
            });
        })()));
        try {
            await Promise.race([started, publishers.then(() => { throw new Error('Publishers missed rendezvous'); })]);
            const writeAt = Date.now();
            const rateBeforeWrite = publications * 1000 / (writeAt - began);
            await withAuthenticatedTestApp(registerMachineAccessRoutes, async app => {
                const response = await app.inject({ method: phase === 'upgrade' ? 'PUT' : 'DELETE',
                    url: `/v1/machines/${f.machine.id}/access`, headers: { 'x-test-user-id': f.owner.id },
                    payload: { principal: { kind: 'account', accountId: f.recipient.id }, ...(phase === 'upgrade' ? { level: 'admin' } : {}) } });
                console.info('qb81-hot-recipient', { phase, elapsedMs: Date.now() - writeAt, rateBeforeWrite,
                    publicationsPerSecond: publications * 1000 / (Date.now() - began), publications, maximumHoldMs });
                expect(response.statusCode, response.body).toBe(200);
                expect(MachineAccessMutationResultV1Schema.parse(response.json())).toMatchObject(
                    phase === 'upgrade' ? { kind: 'saved', grant: { level: 'admin' } } : { kind: 'removed', effectiveAccess: 'none' });
            });
            expect(await db.machineGrant.findUnique({ where: { principalKind: 'account', machineId_accountId: { machineId: f.machine.id, accountId: f.recipient.id } } }))
                .toEqual(phase === 'upgrade' ? expect.objectContaining({ accessLevel: 'admin' }) : null);
            expect(await db.accountChange.findMany({ where: { kind: 'machineRecipientAccess', entityId: f.machine.id },
                select: { accountId: true }, orderBy: { accountId: 'asc' } }))
                .toEqual([f.owner.id, f.recipient.id].sort().map(accountId => ({ accountId })));
        } finally {
            stop = true;
            const outcomes = await publishers;
            vi.unstubAllEnvs();
            for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
        }
    });

    it.each(['authority', 'currentness', 'audience'] as const)('revalidates %s after the Account admission fence', async change => {
        const f = await fixture();
        const manager = await db.account.create({ data: { id: `a-${randomUUID()}`, encryptionMode: 'plain' } });
        const restore = beforeAdmissionFence(async () => {
            if (change === 'authority') await db.account.update({ where: { id: f.owner.id }, data: { status: 'suspended' } });
            else if (change === 'currentness') await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date() } });
            else await db.machineGrant.create({ data: { principalKind: 'account', machineId: f.machine.id, accountId: manager.id,
                accessLevel: 'admin', createdByAccountId: f.owner.id } });
        });
        try {
            await withAuthenticatedTestApp(registerMachineAccessRoutes, async app => {
                const response = await app.inject({ method: 'PUT', url: `/v1/machines/${f.machine.id}/access`,
                    headers: { 'x-test-user-id': f.owner.id },
                    payload: { principal: { kind: 'account', accountId: f.recipient.id }, level: 'admin' } });
                expect(response.statusCode, response.body).toBe(200);
                expect(MachineAccessMutationResultV1Schema.parse(response.json())).toMatchObject(
                    change === 'audience' ? { kind: 'saved' } : { kind: 'refused', code: 'access_denied' });
            });
            expect(await db.machineGrant.findUniqueOrThrow({ where: { principalKind: 'account', machineId_accountId: { machineId: f.machine.id, accountId: f.recipient.id } } }))
                .toMatchObject({ accessLevel: change === 'audience' ? 'admin' : 'view' });
            expect(await db.accountChange.count({ where: { kind: 'machineRecipientAccess', entityId: f.machine.id, accountId: manager.id } }))
                .toBe(change === 'audience' ? 1 : 0);
        } finally { restore(); }
    });

    it.each([
        { kind: 'team', retries: '0' }, { kind: 'team', retries: '1' },
        { kind: 'group', retries: '0' }, { kind: 'group', retries: '1' },
    ] as const)('replays prospective $kind audience growth with retries=$retries', async ({ kind, retries }) => {
        const f = await fixture();
        const member = await db.account.create({ data: { id: `a-${randomUUID()}`, encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Prospective audience' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: f.owner.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Prospective group', nameKey: randomUUID() } });
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', retries);
        const restore = beforeAdmissionFence(async () => {
            const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'member' } });
            if (kind === 'group') await db.teamGroupMembership.create({ data: { teamId: team.id,
                teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        });
        try {
            await withAuthenticatedTestApp(registerMachineAccessRoutes, async app => {
                const response = await app.inject({ method: 'PUT', url: `/v1/machines/${f.machine.id}/access`,
                    headers: { 'x-test-user-id': f.owner.id }, payload: { level: 'view', principal: kind === 'team'
                        ? { kind, teamId: team.id } : { kind, teamId: team.id, groupId: group.id } } });
                expect(response.statusCode, response.body).toBe(retries === '0' ? 503 : 200);
                expect(response.json()).toMatchObject(retries === '0'
                    ? { error: 'database_transaction_conflict_exhausted' } : { kind: 'saved' });
            });
            const where = { machineId: f.machine.id };
            expect(kind === 'team' ? await db.machineGrant.count({ where: { ...where, principalKind: 'team' } }) : await db.machineGrant.count({ where: { ...where, principalKind: 'group' } }))
                .toBe(retries === '0' ? 0 : 1);
            expect(await db.accountChange.count({ where: { accountId: member.id, kind: 'machineRecipientAccess', entityId: f.machine.id } }))
                .toBe(retries === '0' ? 0 : 1);
        } finally { restore(); vi.unstubAllEnvs(); }
    });

    it.each(['content', 'recipient', 'grant'] as const)('refuses stale %s material after the key-commit fence', async change => {
        const ownerKeys = tweetnacl.box.keyPair();
        const recipientKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(recipientKeys.publicKey) } });
        const earlierKeys = tweetnacl.box.keyPair();
        const earlier = await db.account.create({ data: { id: `a-${randomUUID()}`, encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(earlierKeys.publicKey) } });
        const dataKey = tweetnacl.randomBytes(32);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: 'opaque', dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: earlier.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { machineId: machine.id, actorAccountId: owner.id }));
        if ('kind' in census) throw new Error(census.code);
        expect(census.recipients.map(row => row.recipientAccountId)).toEqual([earlier.id, recipient.id].sort());
        const restore = beforeAdmissionFence(async () => {
            if (change === 'content') await db.machine.update({ where: { id: machine.id }, data: { metadataVersion: { increment: 1 } } });
            else if (change === 'recipient') await db.account.update({ where: { id: recipient.id }, data: createSignedAccountContentBinding() });
            else await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: machine.id, accountId: recipient.id } } });
        });
        try {
            await withAuthenticatedTestApp(registerMachineAccessRoutes, async app => {
                const response = await app.inject({ method: 'PATCH', url: `/v1/machines/${machine.id}/data-key-envelopes`,
                    headers: { 'x-test-user-id': owner.id }, payload: {
                        expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint,
                        expectedCallerDataEncryptionKey: census.callerDataEncryptionKey,
                        expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
                        recipientKeyEnvelopes: [{ recipientAccountId: earlier.id,
                            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                                recipientPublicKey: earlierKeys.publicKey, randomBytes: tweetnacl.randomBytes })),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(earlierKeys.publicKey) },
                        { recipientAccountId: recipient.id,
                            encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                                recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes })),
                            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKeys.publicKey) }],
                    } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual({ kind: 'refused', code: change === 'content' ? 'machine_key_changed'
                    : change === 'recipient' ? 'recipient_binding_changed' : 'access_denied' });
            });
            expect(await db.machineKeyEnvelope.count({ where: { machineId: machine.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { kind: 'machine', entityId: machine.id } })).toBe(0);
        } finally { restore(); }
    });
});
