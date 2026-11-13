import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { readSessionAccountCursorAudienceInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { updatePendingMessage } from '@/app/session/pending/pendingMessageService';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, inTx, type Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { buildPluginAccountStoragePhysicalKey } from '@/app/kv/accountScopedKv';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { admitManagedAcquire } from '@/app/machines/managed/managedAcquire';
import { submitManagedAcquire } from '@/app/machines/managed/managedMutations';
import { readManagedResourceDependenciesInTx } from '@/app/machines/managed/managedRead';
import { createNativeSessionTeamCredentialFixture, TEST_AUTHENTICATION } from '@/app/teams/credentials/sessionBinding.testkit';
import { writeSessionTeamCredentialBindingsInTx, stampSessionTeamCredentialNativeDeliveryInTx,
    submitSessionTeamCredentialNativeDeliveryInTx } from '@/app/teams/credentials/sessionBinding';

import { deleteAccountForErasure, erasePluginAccountData } from './accountDataErase';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

type BlockingBackend = Readonly<{ pid: number; query: string; blockers: number[] }>;

async function readBackendsBlockedBy(pid: number): Promise<BlockingBackend[]> {
    return db.$queryRawUnsafe<BlockingBackend[]>(
        'SELECT pid, query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity '
        + 'WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))',
        pid,
    );
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account erasure terminal tail', () => {
    const previousRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    const previousStoragePolicy = process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
    const previousServerIdentity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    const homeId = `srv_${'e'.repeat(32)}`;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('A disposable PostgreSQL contract DATABASE_URL is required');
        process.env.HAPPIER_DB_TX_MAX_RETRIES = '0';
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        process.env.HAPPIER_SERVER_IDENTITY_ID = homeId;
        initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await shutdownDbClient();
        if (previousRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = previousRetries;
        if (previousStoragePolicy === undefined) delete process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY;
        else process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = previousStoragePolicy;
        if (previousServerIdentity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousServerIdentity;
    });

    it.each(['plugin', 'owner-retirement'] as const)('commits %s erasure after a hot Account cursor advances', async shape => {
        const account = await db.account.create({ data: { encryptionMode: 'plain', homeRole: shape === 'owner-retirement' ? 'owner' : 'member' } });
        const survivor = shape === 'owner-retirement' ? await db.account.create({ data: { encryptionMode: 'plain', homeRole: 'owner' } }) : null;
        const pluginId = 'example.erasure-hot';
        const key = buildPluginAccountStoragePhysicalKey(pluginId);
        await db.userKVStore.create({ data: { accountId: account.id, key, version: 0, value: new TextEncoder().encode('erased fixture') } });
        const transaction = db.$transaction;
        let advances = 0;
        // Real concurrent commits invalidate every SSI attempt's Account view;
        // current admission under RC must still tombstone/retire exactly once.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const current = await tx.account.findUnique({ where: { id: account.id }, select: { seq: true } });
                if (current) {
                    advances += 1;
                    await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                }
                return callback(tx);
            }, ...args.slice(1)]);
        } });
        try {
            if (shape === 'plugin') {
                expect(await erasePluginAccountData({ accountId: account.id, pluginId })).toMatchObject({ status: 'erased' });
                expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toBeNull();
                expect(advances).toBe(1);
            } else {
                expect(await deleteAccountForErasure({ accountId: account.id })).toEqual({ status: 'deleted' });
                expect(await db.account.findUnique({ where: { id: account.id } })).toBeNull();
                expect(await db.account.findUniqueOrThrow({ where: { id: survivor!.id }, select: { homeRole: true, status: true } }))
                    .toEqual({ homeRole: 'owner', status: 'active' });
            }
        } finally {
            db.$transaction = transaction;
            await db.account.deleteMany({ where: { id: { in: [account.id, ...(survivor ? [survivor.id] : [])] } } });
        }
    });

    it('keeps one active Home owner when both owners concurrently erase themselves', async () => {
        const owners = await Promise.all([0, 1].map(() => db.account.create({ data: { encryptionMode: 'plain', homeRole: 'owner' } })));
        expect(await db.account.count({ where: { homeRole: 'owner', status: 'active' } })).toBe(2);
        const transaction = db.$transaction;
        const rounds = new Map<string, { arrivals: number; release: ReturnType<typeof deferred> }>();
        // Both requests establish their view before either can acquire the
        // existing complete sorted lifecycle cohort, for every isolation round.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            const options = args[1] as { isolationLevel?: string } | undefined;
            const isolation = options?.isolationLevel ?? 'default';
            let seen = false;
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (!seen && query.includes('FROM "Account"') && query.includes('FOR UPDATE')) {
                        seen = true;
                        let round = rounds.get(isolation);
                        if (!round) { round = { arrivals: 0, release: deferred() }; rounds.set(isolation, round); }
                        round.arrivals += 1;
                        if (round.arrivals >= 2) round.release.resolve();
                        await round.release.promise;
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } })), ...args.slice(1)]);
        } });
        try {
            const outcomes = await Promise.allSettled(owners.map(owner => deleteAccountForErasure({ accountId: owner.id })));
            for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
            const results = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
            expect(results).toContainEqual({ status: 'deleted' });
            expect(results).toContainEqual({ status: 'failed', code: 'home_owner_transfer_required' });
            expect(await db.account.count({ where: { homeRole: 'owner', status: 'active' } })).toBe(1);
        } finally {
            db.$transaction = transaction;
            for (const round of rounds.values()) round.release.resolve();
            await db.account.deleteMany({ where: { id: { in: owners.map(owner => owner.id) } } });
        }
    });

    it('holds the plugin dependency census against the canonical managed submit producer', async () => {
        const pluginId = 'example.erasure-managed';
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
        const launch = defineProtocolObject({ image: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const native = defineProtocolObject({ id: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
        const roles = defineMachineProvisionerSchemas({ launch, resource: native });
        const actions = [
            { id: 'check', inputSchema: roles.checkInput.jsonSchema, resultSchema: MachineProvisionerCheckResultProtocolV1Schema.jsonSchema },
            { id: 'acquire', inputSchema: roles.acquireInput.jsonSchema, resultSchema: roles.acquireResult.jsonSchema },
            { id: 'bootstrap', inputSchema: roles.bootstrapInput.jsonSchema, resultSchema: MachineProvisionerBootstrapCarrierV1Schema.jsonSchema },
            { id: 'inspect', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerObservationV1Schema.jsonSchema },
            { id: 'destroy', inputSchema: roles.resourceInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
            { id: 'power', inputSchema: roles.powerInput.jsonSchema, resultSchema: MachineProvisionerPowerResultV1Schema.jsonSchema },
        ];
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
            displayName: 'Erasure admission fixture', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const requestId = randomUUID();
        const admitted = await admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id,
            requestEnvelopeDigest: 'erasure-admission-test', input: { requestId, continuationPresent: false, input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: {
                kind: 'one-off', homeId, controller, launch: { provider: { pluginId, localId: 'compute' }, schemaVersion: 1,
                    name: 'Guest', choices: { image: 'linux' } }, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            } } } });
        const transaction = db.$transaction;
        let submit: ReturnType<typeof submitManagedAcquire> | undefined;
        let settled = false;
        let blockedAtAccount = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== 'managedMachine') return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.managedMachine, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== 'findMany') return operation;
                    return async (...parameters: unknown[]) => {
                        const result: unknown = await Reflect.apply(operation, delegate, parameters);
                        if (!submit) {
                            const [{ pid }] = await inner.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            submit = submitManagedAcquire({ homeId, managedId: admitted.machine.id, controller,
                                requestId, expectedIntentRevision: 0 }).finally(() => { settled = true; });
                            while (!settled) {
                                const waiting = await readBackendsBlockedBy(pid);
                                if (waiting.length > 0) { blockedAtAccount = waiting.some(backend => backend.query.includes('Account')); break; }
                            }
                            expect(blockedAtAccount).toBe(true);
                            expect((await db.managedMachine.findUniqueOrThrow({ where: { id: admitted.machine.id } })).allocation).toBe('unsubmitted');
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            expect(await erasePluginAccountData({ accountId: account.id, pluginId })).toMatchObject({ status: 'erased' });
            expect(await submit).toMatchObject({ submitted: true });
            expect(blockedAtAccount).toBe(true);
            expect(await erasePluginAccountData({ accountId: account.id, pluginId })).toMatchObject({
                status: 'managed-resources-review-required', resources: [{ managedId: admitted.machine.id, allocation: 'may-exist' }],
            });
        } finally {
            db.$transaction = transaction;
            if (submit) await Promise.allSettled([submit]);
            await db.managedMachine.deleteMany({ where: { custodianAccountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });

    it.each(['owned-discussion', 'foreign-discussion', 'authored-session', 'owned-machine', 'authored-machine'] as const)(
        'physically erases an Account with %s cleanup outside its status audience', async shape => {
            const suffix = randomUUID();
            const accountId = `erased-${suffix}`;
            const ownerId = `owner-${suffix}`;
            const recipientId = `recipient-${suffix}`;
            await db.account.createMany({ data: [
                { id: accountId, encryptionMode: 'plain', status: 'disabled' },
                { id: ownerId, encryptionMode: 'plain' },
                { id: recipientId, encryptionMode: 'plain' },
            ] });
            let discussionId: string | undefined;
            let sessionId: string | undefined;
            let machineId: string | undefined;
            try {
                if (shape === 'owned-machine' || shape === 'authored-machine') {
                    const machine = await db.machine.create({ data: {
                        id: `machine-${suffix}`, accountId: shape === 'owned-machine' ? accountId : ownerId, metadata: '{}',
                    } });
                    machineId = machine.id;
                    await db.machineGrant.create({ data: { principalKind: 'account' as const, machineId, accountId: recipientId,
                        createdByAccountId: accountId, accessLevel: 'view' } });
                } else if (shape === 'authored-session') {
                    const session = await db.session.create({ data: {
                        accountId: ownerId, tag: suffix, encryptionMode: 'plain', metadata: '{}',
                    } });
                    sessionId = session.id;
                    // A previously delegated access but no longer has any access itself.
                    await db.sessionGrant.create({ data: { principalKind: 'account', sessionId, createdByAccountId: accountId,
                        accountId: recipientId, accessLevel: 'view' } });
                } else {
                    const discussion = await db.discussion.create({ data: {
                        ownerAccountId: shape === 'owned-discussion' ? accountId : ownerId,
                        encryptionMode: 'plain', dataEncryptionKey: new Uint8Array(),
                        creationLocalId: suffix, creationEqualityEvidenceV1: {},
                        titleContent: { t: 'plain', v: 'Retained discussion' }, lastMessageAt: new Date(),
                    } });
                    discussionId = discussion.id;
                    await db.discussionGrant.create({ data: { principalKind: 'account' as const, discussionId, accountId: recipientId,
                        createdByAccountId: accountId, accessLevel: 'view' } });
                    if (shape === 'foreign-discussion') await db.discussionGrant.create({ data: { principalKind: 'account' as const,
                        discussionId, accountId, createdByAccountId: ownerId, accessLevel: 'edit',
                    } });
                }
                expect(await deleteAccountForErasure({ accountId })).toEqual({ status: 'deleted' });
                expect(await db.account.findUnique({ where: { id: accountId } })).toBeNull();
                if (machineId) {
                    expect(await db.machine.findUnique({ where: { id: machineId }, select: { accountId: true } }))
                        .toEqual(shape === 'owned-machine' ? null : { accountId: ownerId });
                    expect(await db.machineGrant.count({ where: { principalKind: 'account', machineId } })).toBe(0);
                } else if (sessionId) {
                    expect(await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { accountId: true } }))
                        .toEqual({ accountId: ownerId });
                    expect(await db.sessionGrant.findUniqueOrThrow({ where: { principalKind: 'account',
                        sessionId_accountId: { sessionId, accountId: recipientId },
                    }, select: { createdByAccountId: true, accessLevel: true } }))
                        .toEqual({ createdByAccountId: ownerId, accessLevel: 'view' });
                } else if (shape === 'owned-discussion') {
                    expect(await db.discussion.findUnique({ where: { id: discussionId } })).toBeNull();
                } else {
                    expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId }, select: { ownerAccountId: true } }))
                        .toEqual({ ownerAccountId: ownerId });
                    expect(await db.discussionGrant.findMany({ where: { principalKind: 'account', discussionId },
                        select: { accountId: true, createdByAccountId: true, accessLevel: true } }))
                        .toEqual([{ accountId: recipientId, createdByAccountId: ownerId, accessLevel: 'view' }]);
                }
                expect(await db.accountChange.count({ where: { accountId: recipientId,
                    kind: machineId ? 'machineRecipientAccess' : sessionId ? 'session' : 'discussion',
                    entityId: machineId ?? sessionId ?? discussionId } })).toBeGreaterThan(0);
            } finally {
                if (machineId) await db.machine.deleteMany({ where: { id: machineId } });
                if (discussionId) await db.discussion.deleteMany({ where: { id: discussionId } });
                if (sessionId) await db.session.deleteMany({ where: { id: sessionId } });
                await db.account.deleteMany({ where: { id: { in: [accountId, ownerId, recipientId] } } });
            }
        },
    );

    it.each(['received-session', 'owned-discussion'] as const)('admits a surviving %s recipient before physical erasure', async shape => {
        const fixtureId = randomUUID();
        const erasedAccountId = `a-erased-${fixtureId}`;
        const ownerAccountId = `z-surviving-${fixtureId}`;
        await db.account.createMany({ data: [
            { id: erasedAccountId, encryptionMode: 'plain', status: 'disabled' },
            { id: ownerAccountId, encryptionMode: 'plain' },
        ] });
        const sharedSession = await db.session.create({ data: {
            accountId: ownerAccountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
            pendingCount: 1, pendingQueueSeq: 1,
        } });
        // This owned resource makes erasure publish a real removal for its own
        // Account before that Account and its change rows cascade away.
        const erasedSession = await db.session.create({ data: {
            accountId: erasedAccountId, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}',
        } });
        if (shape === 'received-session') await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: sharedSession.id, createdByAccountId: ownerAccountId,
            accountId: erasedAccountId, accessLevel: 'edit',
        } });
        const erasedDiscussion = shape === 'owned-discussion' ? await db.discussion.create({ data: {
            ownerAccountId: erasedAccountId, encryptionMode: 'plain', dataEncryptionKey: new Uint8Array(),
            creationLocalId: fixtureId, creationEqualityEvidenceV1: {},
            titleContent: { t: 'plain', v: 'Shared before retirement' }, lastMessageAt: new Date(),
            grants: { create: { principalKind: 'account', accountId: ownerAccountId, createdByAccountId: erasedAccountId, accessLevel: 'view' } },
        } }) : null;
        const authorAccountId = shape === 'received-session' ? erasedAccountId : ownerAccountId;
        const localId = randomUUID();
        await db.sessionPendingMessage.create({ data: {
            sessionId: sharedSession.id, localId, authorAccountId,
            messageRole: 'user', position: 1, requestedAction: { v: 1, kind: 'enqueue' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Retained draft' } } },
        } });
        const editedContent = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Edited by surviving owner' } } } as const;
        const resourceLocked = deferred();
        const releaseResource = deferred();
        let resourcePid = 0;
        let writerFinished = false;
        let erasureFinished = false;
        let writerOutcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof updatePendingMessage>>>[]> | undefined;
        let erasureOutcomes: Promise<PromiseSettledResult<Awaited<ReturnType<typeof deleteAccountForErasure>>>[]> | undefined;
        // This fixture-only SQL barrier never replaces a production writer. It
        // positions the public Pending editor after admission, before Session work.
        const holderOutcomes = Promise.allSettled([inTx(async tx => {
            const [backend] = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            resourcePid = backend.pid;
            await tx.$queryRawUnsafe('SELECT "id" FROM "Session" WHERE "id" = $1 FOR NO KEY UPDATE', sharedSession.id);
            resourceLocked.resolve();
            await releaseResource.promise;
        })]);

        try {
            const census = await inReadSnapshot(tx => readSessionAccountCursorAudienceInTx(tx, [sharedSession.id], []));
            // Retired members still own attribution rows touched by Account FK
            // actions. They must remain in admission even though publication
            // and content disclosure exclude inactive recipients.
            expect(census.accountIds).toEqual(shape === 'received-session' ? [erasedAccountId, ownerAccountId] : [ownerAccountId]);
            await Promise.race([resourceLocked.promise, holderOutcomes.then(() => {
                throw new Error('Session resource barrier ended before acquisition');
            })]);
            writerOutcomes = Promise.allSettled([updatePendingMessage({
                actorUserId: ownerAccountId, sessionId: sharedSession.id, localId,
                authentication: createPresentUserSessionAccessAuthentication(), messageRole: 'user', content: editedContent,
            })]).then(outcomes => { writerFinished = true; return outcomes; });

            let writer: BlockingBackend | undefined;
            while (!writerFinished && !writer) [writer] = await readBackendsBlockedBy(resourcePid);
            expect(writer, 'the real Pending editor must wait at the Session resource after Account admission').toBeDefined();
            if (!writer) throw new Error('Pending editor ended before reaching the Session resource');
            expect(writer.query).toContain('Session');
            // Before erasure starts, the only Account-lock holder is the real
            // Pending editor. NOWAIT observes its protection of the inactive
            // author specifically, not an incidental surviving-owner fence.
            if (shape === 'received-session') await expect(db.$transaction(tx => tx.$queryRawUnsafe(
                'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE NOWAIT', erasedAccountId,
            ))).rejects.toMatchObject({ meta: { code: '55P03' } });

            erasureOutcomes = Promise.allSettled([deleteAccountForErasure({ accountId: erasedAccountId })])
                .then(outcomes => { erasureFinished = true; return outcomes; });
            let erasure: BlockingBackend | undefined;
            while (!erasureFinished && !erasure) [erasure] = await readBackendsBlockedBy(writer.pid);
            expect(erasure, 'exclusive erasure must wait for the ordinary writer before touching Session resources').toBeDefined();
            if (!erasure) throw new Error('Erasure ended before exclusive admission was observed');
            expect(erasure.query).toContain('Account');
            expect(erasure.query).toContain('FOR UPDATE');

            // No grant-removal or attribution cascade can become visible while
            // the other Account's complete entry cohort is holding erasure out.
            expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: sharedSession.id, accountId: erasedAccountId } }))
                .toBe(shape === 'received-session' ? 1 : 0);
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: sharedSession.id, localId } },
                select: { authorAccountId: true } })).toEqual({ authorAccountId });

            releaseResource.resolve();
            const [writerOutcome] = await writerOutcomes;
            const [erasureOutcome] = await erasureOutcomes;
            console.info('account-erasure-shared-pending-order', {
                shape, resourcePid, writerPid: writer.pid, writerBlockers: writer.blockers,
                erasurePid: erasure.pid, erasureBlockers: erasure.blockers,
                writerStatus: writerOutcome.status, erasureStatus: erasureOutcome.status, retries: 0,
                writerResult: writerOutcome.status === 'fulfilled' ? writerOutcome.value : undefined,
                erasureError: erasureOutcome.status === 'rejected' ? String(erasureOutcome.reason) : undefined,
            });
            if (writerOutcome.status === 'rejected') throw writerOutcome.reason;
            expect(writerOutcome.value).toMatchObject({ ok: true });
            if (erasureOutcome.status === 'rejected') throw erasureOutcome.reason;
            expect(erasureOutcome.value).toEqual({ status: 'deleted' });
            expect(await db.account.findUnique({ where: { id: erasedAccountId } })).toBeNull();
            expect(await db.session.findUnique({ where: { id: erasedSession.id } })).toBeNull();
            expect(await db.session.findUniqueOrThrow({ where: { id: sharedSession.id }, select: { accountId: true } }))
                .toEqual({ accountId: ownerAccountId });
            expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: sharedSession.id, localId } },
                select: { authorAccountId: true, content: true } })).toEqual({
                authorAccountId: shape === 'received-session' ? null : ownerAccountId, content: editedContent,
            });
            if (erasedDiscussion) {
                expect(await db.discussion.findUnique({ where: { id: erasedDiscussion.id } })).toBeNull();
                expect(await db.accountChange.count({ where: { accountId: ownerAccountId,
                    kind: 'discussion', entityId: erasedDiscussion.id } })).toBeGreaterThan(0);
            }
            expect(await db.sessionGrant.count({ where: { principalKind: 'account', sessionId: sharedSession.id, accountId: erasedAccountId } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: ownerAccountId, entityId: sharedSession.id } })).toBeGreaterThan(0);
        } finally {
            releaseResource.resolve();
            await holderOutcomes;
            await writerOutcomes;
            await erasureOutcomes;
            if (erasedDiscussion) await db.discussion.deleteMany({ where: { id: erasedDiscussion.id } });
            await db.session.deleteMany({ where: { id: { in: [sharedSession.id, erasedSession.id] } } });
            await db.account.deleteMany({ where: { id: { in: [erasedAccountId, ownerAccountId] } } });
        }
    });

    it.each([
        ['custodian', 'insertion'], ['custodian', 'submission'],
        ['session_owner', 'insertion'], ['session_owner', 'submission'],
    ] as const)('erases %s after a native %s race and publishes current-policy cleanup', async (subject, phase) => {
        const previousFeature = process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED;
        process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = '1';
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        const release = deferred();
        const ready = deferred();
        let holderPid = 0;
        let holder: Promise<unknown> | undefined;
        let erasure: ReturnType<typeof deleteAccountForErasure> | undefined;
        try {
            const f = await createNativeSessionTeamCredentialFixture();
            if (subject === 'custodian') await db.teamMembership.update({ where: { id: f.membership.id }, data: { role: 'owner' } });
            const accountId = subject === 'custodian' ? f.custodian.id : f.creator.id;
            const dependencies = await inTx(tx => readManagedResourceDependenciesInTx(tx, {
                kind: 'account', accountId,
            }));
            const managedResourceDispositions = dependencies.map(dependency => ({
                managedId: dependency.managedId, expectedIntentRevision: dependency.intentRevision,
                expectedAllocation: dependency.allocation, expectedResource: dependency.resource,
                expectedNativeOperationRef: dependency.nativeOperationRef, expectedRecovery: dependency.recovery,
                responsibility: 'manual' as const,
            }));
            const prepare = async (tx: Tx) => {
                expect(await writeSessionTeamCredentialBindingsInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, intents: [f.intent], authentication: TEST_AUTHENTICATION })).toEqual({ ok: true });
                const prepared = await stampSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, response: f.sourceResponse, authentication: TEST_AUTHENTICATION });
                if (!prepared.ok) throw new Error('Expected prepared native delivery');
                return prepared.binding.safeFacet.bindingKey;
            };
            const existingBindingKey = phase === 'submission' ? await inTx(prepare) : null;
            holder = inTx(async tx => {
                const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                holderPid = pid;
                const bindingKey = existingBindingKey ?? await prepare(tx);
                expect(await submitSessionTeamCredentialNativeDeliveryInTx(tx, { sessionId: f.session.id,
                    accountId: f.creator.id, bindingKey, expectedResourceRevision: f.credential.revision,
                    expectedSourceRevision: f.nativeSource.sourceRevision, expectedProviderTicket: f.nativeSource.providerTicket,
                    operation: 'install', requestId: randomUUID(), authentication: TEST_AUTHENTICATION }))
                    .toEqual({ ok: true, submitted: true });
                ready.resolve();
                await release.promise;
            }, { isolationLevel: 'ReadCommitted' });
            const holderOutcome = Promise.allSettled([holder]);
            await Promise.race([ready.promise, holder.then(() => { throw new Error('Native acceptance missed rendezvous'); })]);
            let finished = false;
            erasure = deleteAccountForErasure({ accountId, managedResourceDispositions })
                .finally(() => { finished = true; });
            const erasureOutcome = Promise.allSettled([erasure]);
            while (!finished) {
                if ((await readBackendsBlockedBy(holderPid)).length > 0) break;
            }
            release.resolve();
            await holderOutcome;
            await holder;
            await erasureOutcome;
            await expect(erasure).resolves.toEqual({ status: 'deleted' });
            expect(await db.account.findUnique({ where: { id: accountId }, select: { status: true } })).toBeNull();
            expect(await db.sessionTeamCredentialBinding.findMany({ where: { sessionId: f.session.id },
                select: { nativeManagedId: true } })).toEqual([]);
        } finally {
            release.resolve();
            await Promise.allSettled([...(holder ? [holder] : []), ...(erasure ? [erasure] : [])]);
            if (previousFeature === undefined) delete process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED = previousFeature;
            process.env.HAPPIER_SERVER_IDENTITY_ID = homeId;
        }
    });
});
