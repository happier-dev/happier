import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { defineMachineProvisionerSchemas, MachineProvisionerCheckResultProtocolV1Schema,
    MachineProvisionerBootstrapCarrierV1Schema, MachineProvisionerObservationV1Schema,
    MachineProvisionerPowerResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, readPostgresTransactionSqlState, type Tx } from '@/storage/inTx';
import { readDatabaseTransactionConfigFromEnv } from '@/config/databaseTransactions';
import { createDbMaintenanceClient } from '@/storage/prisma';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER, signMachineInstallationProof } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';
import { revokeMachineInTx } from '@/app/machines/machineMutations';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { admitManagedAcquire } from './managedAcquire';
import { cancelManagedCreation } from './managedRead';
import { invalidateManagedMachineInTx, projectManagedMachineInTx, readManagedMachineInTx } from './managedRows';
import { archiveMachinePreset, createMachinePreset, updateMachinePreset } from './machinePresetService';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { removeTeamMemberForActorInTx } from '@/app/teams/memberships/memberAdministration';
import { admitManagedControl, reportManagedAcquire, reportManagedIntent, submitManagedAcquire, submitManagedIntent } from './managedMutations';

async function characterizeUsageContentAdmission(request: Parameters<typeof admitManagedAcquire>[0]) {
    const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (!supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
    const holderClient = await createDbMaintenanceClient('postgres', supplied);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: (pid: number) => void;
    const holderReady = new Promise<number>(resolve => { ready = resolve; });
    // The loaded usage writer holds KEY SHARE while reading/updating its own
    // record. Keep that genuine database boundary open until acquire commits.
    const holder = holderClient.$transaction(async tx => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pg_backend_pid() AS pid FROM "Account" WHERE id = ${request.custodianAccountId} FOR KEY SHARE
        `;
        ready(pid);
        await released;
    }, { timeout: readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs });
    const holderOutcome = Promise.allSettled([holder]);
    const pending: Array<ReturnType<typeof admitManagedAcquire>> = [];
    try {
        const pid = await Promise.race([holderReady, holder.then(() => { throw new Error('Holder missed rendezvous'); })]);
        let settled = false;
        pending.push(admitManagedAcquire(request));
        if (request.input.input.selection.kind === 'preset') {
            pending.push(admitManagedAcquire({ ...request, input: { ...request.input, requestId: randomUUID() } }));
        }
        const outcomes = Promise.allSettled(pending).finally(() => { settled = true; });
        while (!settled) {
            const [state] = await holderClient.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            expect(state.blocked, 'usage content admission must not block managed acquire').toBe(false);
        }
        const results = await outcomes;
        const successful = results.filter(result => result.status === 'fulfilled');
        expect(successful).toHaveLength(1);
        const result = successful[0].value;
        expect(result).toMatchObject({ replayed: false, machine: { allocation: 'unsubmitted' } });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: request.custodianAccountId, kind: 'account', entityId: result.machine.id,
        } } })).not.toBeNull();
        if (request.input.input.selection.kind === 'preset') {
            expect(results.find(result => result.status === 'rejected')?.reason).toMatchObject({ code: 'preset_limit_reached' });
            expect(await db.managedMachine.count({ where: { presetId: request.input.input.selection.id } })).toBe(1);
        }
    } finally {
        release();
        const [outcome] = await holderOutcome;
        await Promise.allSettled(pending);
        await holderClient.$disconnect();
        if (outcome.status === 'rejected') throw outcome.reason;
    }
}

async function characterizeManagedTransientContention(request: Parameters<typeof admitManagedAcquire>[0]) {
    const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (!supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
    const holderClient = await createDbMaintenanceClient('postgres', supplied);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: (pid: number) => void;
    const holderReady = new Promise<number>(resolve => { ready = resolve; });
    const holder = holderClient.$transaction(async tx => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid FROM "Account" WHERE id = ${request.custodianAccountId} FOR UPDATE`;
        ready(pid);
        await released;
    }, { timeout: readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs });
    const holderOutcome = Promise.allSettled([holder]);
    const originalTransaction = db.$transaction;
    let admitted: ReturnType<typeof admitManagedAcquire> | undefined;
    try {
        const pid = await Promise.race([holderReady, holder.then(() => { throw new Error('Holder missed rendezvous'); })]);
        const initial = await db.account.findUniqueOrThrow({ where: { id: request.custodianAccountId }, select: { seq: true } });
        db.$transaction = new Proxy(originalTransaction, {
            async apply(target, thisArg, args) {
                try { return await Reflect.apply(target, thisArg, args); }
                catch (error) { release(); throw error; }
            },
        });
        let settled = false;
        admitted = admitManagedAcquire(request).finally(() => { settled = true; });
        void admitted.catch(() => undefined);
        let blocked = false;
        while (!settled) {
            const [state] = await holderClient.$queryRaw<Array<{ blocked: boolean }>>`
                SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                    WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))) AS blocked
            `;
            if (state.blocked) { blocked = true; break; }
        }
        // Supported zero-retry and default policies both wait for a short peer;
        // successful admission must not depend on first refusing with NOWAIT.
        release();
        await holder;
        expect(await admitted).toMatchObject({ replayed: false });
        expect(blocked).toBe(true);
        expect(await db.managedMachine.count({ where: { custodianAccountId: request.custodianAccountId } })).toBe(1);
        expect(await db.account.findUniqueOrThrow({ where: { id: request.custodianAccountId }, select: { seq: true } }))
            .toEqual({ seq: initial.seq + 1 });
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: (await admitted).machine.id } });
        expect(await db.account.findUniqueOrThrow({ where: { id: request.custodianAccountId }, select: { seq: true } }))
            .toEqual({ seq: initial.seq + 1 });
    } finally {
        db.$transaction = originalTransaction;
        release();
        await holderOutcome;
        if (admitted) await Promise.allSettled([admitted]);
        await holderClient.$disconnect();
    }
}

async function characterizeManagedHotRecipient(request: Parameters<typeof admitManagedAcquire>[0], recipientId: string, phase: 'admit' | 'cancel') {
    const retained = phase === 'cancel' ? await admitManagedAcquire(request) : undefined;
    let stop = false;
    let publications = 0;
    let maximumHoldMs = 0;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const began = Date.now();
    // QB67's three independent short holders sustain about 42 publications/s.
    // The managed writer has no rendezvous with an individual publication.
    const outcomes = Promise.allSettled(Array.from({ length: 3 }, (_, index) => (async () => {
        while (!stop) {
            await inTx(async tx => {
                await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${recipientId} FOR NO KEY UPDATE`;
                const acquiredAt = Date.now();
                await markAccountChanged(tx, { accountId: recipientId, kind: 'account', entityId: `hot-publisher-${index}` });
                await tx.$executeRaw`SELECT pg_sleep(0.02)`;
                publications++;
                maximumHoldMs = Math.max(maximumHoldMs, Date.now() - acquiredAt);
                if (publications === 15) ready();
            });
        }
    })()));
    try {
        await Promise.race([started, outcomes.then(() => { throw new Error('Publishers missed rendezvous'); })]);
        const writeAt = Date.now();
        const publicationRateBeforeWrite = publications * 1000 / (writeAt - began);
        const result = retained
            ? await cancelManagedCreation({ actorAccountId: request.custodianAccountId,
                input: { homeId: retained.machine.homeId, managedId: retained.machine.id, expectedIntentRevision: 0 } })
            : await admitManagedAcquire(request);
        console.info('qb68-hot-recipient', { phase, elapsedMs: Date.now() - writeAt,
            publications, publicationRateBeforeWrite, publicationsPerSecond: publications * 1000 / (Date.now() - began), maximumHoldMs });
        expect(result).toMatchObject({ machine: { allocation: retained ? 'confirmed-absent' : 'unsubmitted',
            creationState: retained ? 'canceled' : 'active', intentRevision: retained ? 1 : 0 } });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: result.machine.id } }))
            .toMatchObject({ allocation: result.machine.allocation, creationState: result.machine.creationState });
        expect(await db.accountChange.findMany({ where: { entityId: result.machine.id }, select: { accountId: true }, orderBy: { accountId: 'asc' } }))
            .toEqual([request.custodianAccountId, recipientId].sort().map(accountId => ({ accountId })));
    } finally {
        stop = true;
        for (const outcome of await outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    }
}

async function characterizeAdmittedReplay(request: Parameters<typeof admitManagedAcquire>[0]) {
    const admitted = await admitManagedAcquire(request);
    const supplied = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
    if (!supplied) throw new Error('Use the disposable PostgreSQL DB-contract harness');
    const holderClient = await createDbMaintenanceClient('postgres', supplied);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const holderReady = new Promise<void>(resolve => { ready = resolve; });
    const holder = holderClient.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${request.custodianAccountId} FOR UPDATE`;
        ready();
        await released;
    }, { timeout: readDatabaseTransactionConfigFromEnv(process.env, 'postgres').timeoutMs });
    const holderOutcome = Promise.allSettled([holder]);
    try {
        await Promise.race([holderReady, holder.then(() => { throw new Error('Holder missed rendezvous'); })]);
        // Home already committed custody. The controller must recover that same
        // admission before accepting its operation, even during unrelated publication.
        expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
        await expect(admitManagedAcquire({ ...request, custodianAccountId: randomUUID() }))
            .rejects.toMatchObject({ code: 'permission_denied' });
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, continuationPresent: true } }))
            .rejects.toMatchObject({ code: 'request_conflict' });
        expect(await db.managedMachine.count({ where: { custodianAccountId: request.custodianAccountId } })).toBe(1);
    } finally {
        release();
        const [outcome] = await holderOutcome;
        await holderClient.$disconnect();
        if (outcome.status === 'rejected') throw outcome.reason;
    }
    const correlation = { homeId: admitted.machine.homeId, managedId: admitted.machine.id,
        controller: admitted.machine.controller, requestId: request.input.requestId, expectedIntentRevision: 0 };
    expect(await submitManagedAcquire(correlation)).toMatchObject({ submitted: true });
    // Native IO is the system boundary between committed submit and report.
    // Keep it unresolved while another real managed writer publishes to the
    // same Account, then settle the original allocation through its report owner.
    let finishNative!: () => void;
    const native = new Promise<void>(resolve => { finishNative = resolve; });
    const operation = native.then(() => reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource: {
        contributionRef: admitted.machine.launch.provider, schemaVersion: 1, value: { id: 'long-native-operation' },
    } } }));
    const operationOutcome = Promise.allSettled([operation]);
    try {
        await expect(admitManagedAcquire({ ...request, input: { ...request.input, requestId: randomUUID() } }))
            .resolves.toMatchObject({ replayed: false });
        expect(await db.managedMachine.count({ where: { custodianAccountId: request.custodianAccountId } })).toBe(2);
    } finally {
        finishNative();
        const [outcome] = await operationOutcome;
        if (outcome.status === 'rejected') throw outcome.reason;
    }
    expect(await operation).toMatchObject({ machine: { id: admitted.machine.id, allocation: 'bound' } });
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('managed admission under PostgreSQL Account contention', () => {
    let originalDatabaseUrl: string;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        originalDatabaseUrl = process.env.DATABASE_URL;
        const url = new URL(originalDatabaseUrl);
        url.searchParams.set('connection_limit', '10');
        url.searchParams.set('pool_timeout', '10');
        url.searchParams.set('application_name', 'happier-qb42-managed-pool');
        process.env.DATABASE_URL = url.toString();
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); process.env.DATABASE_URL = originalDatabaseUrl; });

    it.each([
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetMutation: 'create' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetMutation: 'update' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetMutation: 'archive' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetWithdrawal: 'create' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetWithdrawal: 'update' },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', presetWithdrawal: 'archive' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'admit' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'report' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'submit' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'control' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'intent-submit' },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'intent-report' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', beforeFence: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'submit', beforeFence: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'report', beforeFence: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'admit', beforeFence: true, growAudience: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'admit', beforeFence: true, growAudience: true, replayAudience: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'report', beforeFence: true, growAudience: true, replayAudience: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'invalidate', beforeFence: true, growAudience: true, replayAudience: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', beforeFence: true, retireController: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', transientContention: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', transientContention: true, zeroRetries: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', usageAdmission: true },
        { selectionKind: 'preset', publicationAccount: 'custodian', phase: 'admit', usageAdmission: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'admit', hotRecipient: true },
        { selectionKind: 'one-off', publicationAccount: 'viewer', phase: 'cancel', hotRecipient: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'admit', admittedReplay: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report', foreignRegistration: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report', publicationRegistration: true },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report', staleRegistration: 'creation' },
        { selectionKind: 'one-off', publicationAccount: 'custodian', phase: 'report', staleRegistration: 'controller' },
    ] as const)('$phase $selectionKind survives an unrelated $publicationAccount publication ($beforeFence, transient=$transientContention, zero=$zeroRetries, usage=$usageAdmission, hot=$hotRecipient, replay=$admittedReplay, registration=$foreignRegistration, publicationRegistration=$publicationRegistration, retired=$staleRegistration, presetMutation=$presetMutation, presetWithdrawal=$presetWithdrawal)', async (scenario) => {
        const { selectionKind, publicationAccount, phase } = scenario;
        const beforeFence = 'beforeFence' in scenario && scenario.beforeFence;
        const growAudience = 'growAudience' in scenario && scenario.growAudience;
        const replayAudience = 'replayAudience' in scenario && scenario.replayAudience;
        const retireController = 'retireController' in scenario && scenario.retireController;
        const transientContention = 'transientContention' in scenario && scenario.transientContention;
        const usageAdmission = 'usageAdmission' in scenario && scenario.usageAdmission;
        const homeId = `srv_${'a'.repeat(32)}`;
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', homeId);
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        if (replayAudience) vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '1');
        const hotRecipient = 'hotRecipient' in scenario && scenario.hotRecipient;
        if (hotRecipient || transientContention && !('zeroRetries' in scenario)) {
            // Exercise the complete default PostgreSQL retry policy, regardless
            // of operator settings inherited by the disposable harness process.
            for (const prefix of ['HAPPIER', 'HAPPY']) {
                for (const key of ['MAX_RETRIES', 'RETRY_BASE_DELAY_MS', 'RETRY_MAX_DELAY_MS',
                    'RETRY_JITTER_FACTOR', 'TOTAL_RETRY_BUDGET_MS', 'TIMEOUT_MS', 'MAX_WAIT_MS']) {
                    vi.stubEnv(`${prefix}_DB_TX_${key}`, undefined);
                }
            }
        }
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
            installationId: controller.installationId, pluginMaterializationRevision: BigInt(1) } });
        const viewer = publicationAccount === 'viewer'
            ? await db.account.create({ data: { ...(growAudience ? { id: `a-${randomUUID()}` } : {}),
                publicKey: randomUUID(), encryptionMode: 'plain' } }) : undefined;
        if (viewer && !growAudience) await db.machineAccountGrant.create({ data: { machineId: controller.machineId,
            accountId: viewer.id, createdByAccountId: account.id, accessLevel: 'view' } });
        const publicationAccountId = viewer?.id ?? account.id;
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
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'fixture.admission-contention', version: '1.0.0',
            displayName: 'Admission contention', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                machineProvisioners: [{ id: 'compute', title: 'Guest', icon: 'machine', resourceKind: 'vm', schemaVersion: 1,
                    launchSchema: launch.jsonSchema, resourceSchema: native.jsonSchema, platforms: ['linux'], prerequisites: [],
                    billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }],
                actions: actions.map(action => ({ ...action, title: action.id, execution: { target: 'daemon' },
                    surfaces: ['plugin'], scopes: ['global'], dangerLevel: 'safe' })),
            } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: controller.installationId, pluginId: manifest.id, version: manifest.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
        const launchSnapshot = { provider: { pluginId: manifest.id, localId: 'compute' }, schemaVersion: 1,
            name: 'Guest', choices: { image: 'linux' } };
        const retention = { kind: 'unused' as const, afterMs: 3_600_000, effect: 'stop' as const };
        const presetId = randomUUID();
        const teamOwner = 'presetWithdrawal' in scenario
            ? await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } }) : null;
        const team = teamOwner ? await db.team.create({ data: { name: 'Preset authority' } }) : null;
        if (team && teamOwner) await db.teamMembership.create({ data: { teamId: team.id, accountId: teamOwner.id, role: 'owner' } });
        const membership = team ? await db.teamMembership.create({ data: { teamId: team.id, accountId: account.id, role: 'admin' } }) : null;
        const presetOwner = team ? { kind: 'team' as const, teamId: team.id } : { kind: 'account' as const, accountId: account.id };
        if (selectionKind === 'preset') {
            expect(await createMachinePreset({ accountId: account.id, input: { id: presetId, homeId, name: 'Contended preset',
                owner: presetOwner, controller, launch: launchSnapshot,
                simultaneousLimit: { maximum: 1 } } })).toMatchObject({ kind: 'saved' });
        }
        if ('presetWithdrawal' in scenario && team && teamOwner && membership) {
            vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '1');
            const transaction = db.$transaction;
            const createId = randomUUID();
            let withdrawnCursor: number | undefined;
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                    get(inner, property, innerReceiver) {
                        if (property !== 'managedMachinePreset') return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.managedMachinePreset, { get(model, method, modelReceiver) {
                            const member: unknown = Reflect.get(model, method, modelReceiver);
                            if (method !== 'create' && method !== 'updateMany' || typeof member !== 'function') return member;
                            return (...values: unknown[]) => observeLazyPrismaQuery(Reflect.apply(member, model, values),
                                () => ({ started() {}, settled() {} }), async () => {
                                    if (withdrawnCursor !== undefined) return;
                                    expect(await inTx(peer => removeTeamMemberForActorInTx(peer, { teamId: team.id,
                                        actorAccountId: teamOwner.id, membershipId: membership.id }))).toMatchObject({ ok: true });
                                    withdrawnCursor = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
                                });
                        } });
                    },
                })), ...args.slice(1)]);
            } });
            try {
                const result = scenario.presetWithdrawal === 'create'
                    ? await createMachinePreset({ accountId: account.id, input: { id: createId, homeId, name: 'Withdrawn create',
                        owner: presetOwner, controller, launch: launchSnapshot } })
                    : scenario.presetWithdrawal === 'update'
                        ? await updateMachinePreset({ accountId: account.id, input: { id: presetId, homeId, expectedRevision: 0,
                            patch: { name: 'Withdrawn update' } } })
                        : await archiveMachinePreset({ accountId: account.id, input: { id: presetId, homeId, expectedRevision: 0 } });
                expect(withdrawnCursor).toBeDefined();
                expect(result).toMatchObject({ kind: 'refused' });
                expect(await db.managedMachinePreset.findUnique({ where: { id: createId } })).toBeNull();
                expect(await db.managedMachinePreset.findUniqueOrThrow({ where: { id: presetId } }))
                    .toMatchObject({ revision: 0, archivedAt: null, name: 'Contended preset' });
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ seq: withdrawnCursor });
            } finally {
                db.$transaction = transaction; vi.unstubAllEnvs();
                await db.managedMachinePreset.deleteMany({ where: { id: { in: [presetId, createId] } } });
                await db.team.delete({ where: { id: team.id } });
                await db.machine.deleteMany({ where: { accountId: account.id } });
                await db.account.delete({ where: { id: account.id } }); await db.account.delete({ where: { id: teamOwner.id } });
            }
            return;
        }
        if ('presetMutation' in scenario) {
            const transaction = db.$transaction;
            const initial = (await db.account.findUniqueOrThrow({ where: { id: account.id } })).seq;
            let peerWrites = 0;
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                let advanced = false;
                return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                    get(inner, property, innerReceiver) {
                        if (property !== '$queryRawUnsafe') return Reflect.get(inner, property, innerReceiver);
                        return (query: string, ...values: unknown[]) => {
                            const pending = inner.$queryRawUnsafe(query, ...values);
                            if (!query.includes('FROM "Account"') || !query.includes('FOR NO KEY UPDATE')) return pending;
                            return observeLazyPrismaQuery(pending, () => ({ started() {}, settled() {} }), async () => {
                                if (advanced) return;
                                advanced = true;
                                await db.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
                                peerWrites++;
                            });
                        };
                    },
                })), ...args.slice(1)]);
            } });
            try {
                const result = scenario.presetMutation === 'create'
                    ? await createMachinePreset({ accountId: account.id, input: { id: randomUUID(), homeId, name: 'Hot preset',
                        owner: { kind: 'account', accountId: account.id }, controller, launch: launchSnapshot } })
                    : scenario.presetMutation === 'update'
                        ? await updateMachinePreset({ accountId: account.id, input: { id: presetId, homeId, expectedRevision: 0,
                            patch: { name: 'Hot renamed preset' } } })
                        : await archiveMachinePreset({ accountId: account.id, input: { id: presetId, homeId, expectedRevision: 0 } });
                expect(peerWrites).toBe(1);
                expect(result).toMatchObject({ kind: 'saved', preset: { revision: scenario.presetMutation === 'create' ? 0 : 1 } });
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ seq: initial + 2 });
                if (scenario.presetMutation !== 'create') {
                    const stale = await updateMachinePreset({ accountId: account.id, input: { id: presetId, homeId,
                        expectedRevision: 0, patch: { name: 'Stale overwrite' } } });
                    expect(stale).toMatchObject({ kind: 'conflict', currentRevision: 1 });
                }
            } finally {
                db.$transaction = transaction;
                vi.unstubAllEnvs();
                await db.managedMachinePreset.deleteMany({ where: { custodianAccountId: account.id } });
                await db.machine.deleteMany({ where: { accountId: account.id } });
                await db.account.delete({ where: { id: account.id } });
            }
            return;
        }
        const request: Parameters<typeof admitManagedAcquire>[0] = {
            custodianAccountId: account.id, requesterAccountId: account.id, requestEnvelopeDigest: 'contention-test',
            input: { requestId: randomUUID(), continuationPresent: false, input: selectionKind === 'one-off'
                ? { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'one-off', homeId, controller, launch: launchSnapshot, retention, wakeOnAcceptedMessage: true } }
                : { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'preset', homeId, id: presetId, revision: 0 }, controller, retention, wakeOnAcceptedMessage: true } },
        };
        const allocated = !hotRecipient && phase !== 'admit' ? await admitManagedAcquire(request) : undefined;
        const correlation = allocated ? { homeId, managedId: allocated.machine.id, controller,
            requestId: request.input.requestId, expectedIntentRevision: 0 } : undefined;
        const resource = { contributionRef: launchSnapshot.provider, schemaVersion: 1, value: { id: 'native-created-before-report' } };
        if (correlation && phase !== 'submit') await submitManagedAcquire(correlation);
        if (correlation && ['control', 'intent-submit', 'intent-report'].includes(phase)) {
            await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
        }
        const control = correlation ? { actorAccountId: account.id, custodianAccountId: account.id, input: {
            action: 'machines.managed.delete' as const, requestId: randomUUID(), input: { homeId, managedId: correlation.managedId,
                when: 'now' as const, expectedRevision: 0, intent: 'delete' as const, reviewedDependencies: true as const },
        } } : undefined;
        if (control && ['intent-submit', 'intent-report'].includes(phase)) await admitManagedControl(control);
        const intentCorrelation = correlation && control ? { ...correlation, expectedIntentRevision: 1, requestId: control.input.requestId } : undefined;
        if (intentCorrelation && phase === 'intent-report') await submitManagedIntent(intentCorrelation);
        const { seq: initialSeq } = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
        const viewerSeq = viewer ? (await db.account.findUniqueOrThrow({ where: { id: viewer.id }, select: { seq: true } })).seq : 0;
        const originalTransaction = db.$transaction;
        let writer: Promise<unknown> | undefined;
        let writerOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
        let interleaved = false;
        // Interleave only at the real Prisma transport; all domain owners and SQL remain real.
        db.$transaction = hotRecipient || transientContention || usageAdmission ? originalTransaction : new Proxy(originalTransaction, {
            apply(target, thisArg, args) {
                const callback: unknown = args[0];
                if (typeof callback !== 'function') return Reflect.apply(target, thisArg, args);
                return Reflect.apply(target, thisArg, [async (tx: Tx) => {
                    const machines = new Proxy(tx.managedMachine, {
                        get(owner, property, receiver) {
                            const method: unknown = Reflect.get(owner, property, receiver);
                            if (beforeFence || property !== (phase === 'admit' ? 'create' : 'updateMany') || typeof method !== 'function') return method;
                            return async (...values: unknown[]) => {
                                let ready!: (pid: number) => void;
                                const started = new Promise<number>(resolve => { ready = resolve; });
                                let settled = false;
                                writer = inTx(async (peer: Tx) => {
                                    const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                    ready(pid);
                                    // The same canonical publication that competes with admission in the live server.
                                    return markAccountChanged(peer, { accountId: publicationAccountId, kind: 'account', entityId: 'unrelated-publication' });
                                }, { isolationLevel: 'ReadCommitted' });
                                writerOutcome = Promise.allSettled([writer!]).finally(() => { settled = true; });
                                const pid = await Promise.race([started, writer!.then(() => { throw new Error('Writer missed rendezvous'); })]);
                                while (!settled) {
                                    const [state] = await db.$queryRaw<Array<{ waiting: boolean }>>`
                                        SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS waiting
                                    `;
                                    if (state.waiting) break;
                                }
                                return Reflect.apply(method, owner, values);
                            };
                        },
                    });
                    return callback(new Proxy(tx, { get(owner, property, receiver) {
                        if (property === 'managedMachine') return machines;
                        const method: unknown = Reflect.get(owner, property, receiver);
                        if (property !== '$queryRawUnsafe' || typeof method !== 'function' || !beforeFence) return method;
                        return async (...values: unknown[]) => {
                            if (!interleaved && typeof values[0] === 'string'
                                && values[0].startsWith('SELECT "id" FROM "Account"')) {
                                interleaved = true;
                                // Commit after audience discovery, before its first lock.
                                writer = inTx(async peer => {
                                    if (retireController) await peer.machine.update({ where: { id: controller.machineId },
                                        data: { installationId: randomUUID() } });
                                    if (growAudience && viewer) await peer.machineAccountGrant.create({ data: {
                                        machineId: controller.machineId, accountId: viewer.id,
                                        createdByAccountId: account.id, accessLevel: 'view' } });
                                    return markAccountChanged(peer, { accountId: publicationAccountId,
                                        kind: 'account', entityId: 'unrelated-publication' });
                                }, { isolationLevel: 'ReadCommitted' });
                                writerOutcome = Promise.allSettled([writer]);
                                await writer;
                            }
                            return Reflect.apply(method, owner, values);
                        };
                    } }));
                }, args[1]]);
            },
        });
        try {
            if ('foreignRegistration' in scenario || 'publicationRegistration' in scenario || 'staleRegistration' in scenario) {
                db.$transaction = originalTransaction;
                if (!correlation) throw new Error('Registration requires a current managed admission');
                await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } });
                const guestId = randomUUID();
                const keys = tweetnacl.sign.keyPair();
                const identity = { version: 1 as const, machineId: guestId, accountId: account.id, installationId: randomUUID() };
                const payload = { id: guestId, metadata: encodePlainMachineStoredContent({ host: 'guest' }),
                    dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, managedEnrollment: { ...correlation, resource },
                    installationId: identity.installationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url'),
                    installationProof: signMachineInstallationProof({ payload: identity, privateKey: keys.secretKey }) };
                const headers = { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' };
                if ('publicationRegistration' in scenario) {
                    let scheduled = false;
                    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
                        const callback = args[0];
                        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                        const result = Reflect.apply(target, receiver, [async (tx: Tx) => {
                            const query = tx.$queryRawUnsafe.bind(tx);
                            const publicationQuery = new Proxy(query, { async apply(owner, receiver, values: Parameters<typeof query>) {
                                if (!scheduled && values[0].includes('FROM "Account"') && values[0].endsWith('FOR NO KEY UPDATE')) {
                                    scheduled = true;
                                    let ready!: (pid: number) => void;
                                    const started = new Promise<number>(resolve => { ready = resolve; });
                                    let settled = false;
                                    writer = inTx(async peer => {
                                        const [{ pid }] = await peer.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                                        ready(pid);
                                        return markAccountChanged(peer, { accountId: account.id, kind: 'account', entityId: 'registration-peer' });
                                    });
                                    writerOutcome = Promise.allSettled([writer]).finally(() => { settled = true; });
                                    const pid = await Promise.race([started, writer.then(() => { throw new Error('Publication missed rendezvous'); })]);
                                    // Existing KEY SHARE lets the peer commit; exclusive
                                    // admission makes it wait until registration commits.
                                    while (!settled) {
                                        const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                                            SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked
                                        `;
                                        if (blocked) break;
                                    }
                                }
                                return Reflect.apply(owner, receiver, values);
                            } });
                            return callback(new Proxy(tx, { get(owner, property, receiver) {
                                return property === '$queryRawUnsafe' ? publicationQuery : Reflect.get(owner, property, receiver);
                            } }));
                        }, ...args.slice(1)]) as Promise<unknown>;
                        return result.catch((error: unknown) => {
                            console.info('QB146_REGISTRATION_TRANSACTION_ERROR', {
                                prismaCode: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
                                sqlState: readPostgresTransactionSqlState(error),
                            });
                            throw error;
                        });
                    } });
                    await withAuthenticatedTestApp(machinesRoutes, async app => {
                        const response = await app.inject({ method: 'POST', url: '/v1/machines', headers, payload });
                        console.info('QB146_PUBLICATION_REGISTRATION', { scheduled, status: response.statusCode });
                        expect(scheduled).toBe(true);
                        expect(response.statusCode, response.body).toBe(200);
                        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: correlation.managedId } }))
                            .toMatchObject({ enrolledMachineId: guestId });
                    });
                    await writer;
                    return;
                }
                if ('staleRegistration' in scenario) {
                    let retired = false;
                    db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
                        const callback = args[0];
                        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                        return Reflect.apply(target, receiver, [async (tx: Tx) => {
                            const query = tx.$queryRawUnsafe.bind(tx);
                            const admissionQuery = new Proxy(query, { async apply(owner, receiver, values: Parameters<typeof query>) {
                                if (!retired && values[0].startsWith('SELECT "id" FROM "Account"')) {
                                    retired = true;
                                    // Commit at the actual database boundary after audience
                                    // discovery but before registration admits that audience.
                                    if (scenario.staleRegistration === 'creation') await cancelManagedCreation({
                                        actorAccountId: account.id, input: { homeId, managedId: correlation.managedId, expectedIntentRevision: 0 },
                                    });
                                    else await inTx(peer => revokeMachineInTx(peer, { accountId: account.id, machineId: controller.machineId }));
                                }
                                return Reflect.apply(owner, receiver, values);
                            } });
                            return callback(new Proxy(tx, { get(owner, property, receiver) {
                                return property === '$queryRawUnsafe' ? admissionQuery : Reflect.get(owner, property, receiver);
                            } }));
                        }, ...args.slice(1)]);
                    } });
                    await withAuthenticatedTestApp(machinesRoutes, async app => {
                        const response = await app.inject({ method: 'POST', url: '/v1/machines', headers, payload });
                        expect(retired).toBe(true);
                        expect(response.statusCode, response.body).toBe(409);
                        expect(await db.machine.findUnique({ where: { id: guestId } })).toBeNull();
                        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: correlation.managedId } }))
                            .toMatchObject({ enrolledMachineId: null });
                    });
                    return;
                }
                const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
                await db.$executeRaw`ANALYZE "Account"`;
                let foreignCommits = 0;
                const isolation: string[] = [];
                // Interleave actual independent SQL commits after registration's
                // domain/publication work. No route or admission logic is mocked.
                db.$transaction = new Proxy(originalTransaction, { apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        const result = await callback(tx);
                        const [mode] = await tx.$queryRaw<Array<{ isolation: string; readOnly: string }>>`
                            SELECT current_setting('transaction_isolation') AS isolation,
                                current_setting('transaction_read_only') AS "readOnly"
                        `;
                        if (mode.readOnly === 'on') return result;
                        isolation.push(mode.isolation);
                        await originalTransaction(async peer => {
                            await peer.account.findUniqueOrThrow({ where: { id: foreign.id } });
                            await peer.account.update({ where: { id: foreign.id }, data: { seq: { increment: 1 } } });
                        }, { isolationLevel: 'Serializable' });
                        foreignCommits++;
                        return result;
                    }, ...args.slice(1)]);
                } });
                try {
                    await withAuthenticatedTestApp(machinesRoutes, async app => {
                        for (const registration of ['create', 'repeat']) {
                            const response = await app.inject({ method: 'POST', url: '/v1/machines', headers, payload });
                            console.info('QB146_REGISTRATION', { registration, status: response.statusCode, foreignCommits, isolation });
                            expect(response.statusCode, response.body).toBe(200);
                            expect(response.json().machine.id).toBe(guestId);
                            expect(await db.managedMachine.findUniqueOrThrow({ where: { id: correlation.managedId } }))
                                .toMatchObject({ enrolledMachineId: guestId, intentRevision: 0, creationState: 'active' });
                        }
                    });
                    expect(foreignCommits).toBeGreaterThanOrEqual(2);
                } finally {
                    db.$transaction = originalTransaction;
                    await db.account.delete({ where: { id: foreign.id } });
                }
                return;
            }
            if ('admittedReplay' in scenario) {
                await characterizeAdmittedReplay(request);
                return;
            }
            if (transientContention) {
                await characterizeManagedTransientContention(request);
                return;
            }
            if (usageAdmission) {
                await characterizeUsageContentAdmission(request);
                return;
            }
            if (hotRecipient && viewer && (phase === 'admit' || phase === 'cancel')) {
                await characterizeManagedHotRecipient(request, viewer.id, phase);
                return;
            }
            if (retireController) {
                await expect(admitManagedAcquire(request)).rejects.toMatchObject({ code: 'controller_retired' });
                expect(interleaved).toBe(true);
                expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(0);
                expect(await db.accountChange.count({ where: { accountId: account.id,
                    entityId: { not: 'unrelated-publication' } } })).toBe(0);
                return;
            }
            if (growAudience && !replayAudience) {
                await expect(admitManagedAcquire(request)).rejects.toMatchObject({
                    code: 'database_transaction_conflict_exhausted',
                    cause: { reason: 'transaction-account-audience-changed' },
                });
                expect(interleaved).toBe(true);
                expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(0);
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: initialSeq });
                expect(await db.account.findUniqueOrThrow({ where: { id: publicationAccountId }, select: { seq: true } })).toEqual({ seq: viewerSeq + 1 });
                return;
            }
            const admitted = phase === 'report' && correlation ? await reportManagedAcquire({ ...correlation, result: { kind: 'bound', resource } })
                : phase === 'invalidate' && correlation ? await inTx(async tx => {
                    const row = await readManagedMachineInTx(tx, correlation);
                    await invalidateManagedMachineInTx(tx, row);
                    return { machine: await projectManagedMachineInTx(tx, row) };
                })
                : phase === 'submit' && correlation ? await submitManagedAcquire(correlation)
                : phase === 'control' && control ? await admitManagedControl(control)
                : phase === 'intent-submit' && intentCorrelation ? await submitManagedIntent(intentCorrelation)
                : phase === 'intent-report' && intentCorrelation ? await reportManagedIntent({ ...intentCorrelation,
                    result: { kind: 'confirmed' }, observation: { observedAt: Date.now(), availability: 'absent' } })
                : await admitManagedAcquire(request);
            await writer;
            if (beforeFence) expect(interleaved).toBe(true);
            expect(admitted).toMatchObject({ machine: { retention, wakeOnAcceptedMessage: true,
                ...(phase === 'report' ? { allocation: 'bound', resource: { value: { id: 'native-created-before-report' } } } : {}),
                ...(phase === 'intent-report' ? { allocation: 'confirmed-absent' } : {}) } });
            expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(1);
            db.$transaction = originalTransaction;
            expect(await admitManagedAcquire(request)).toMatchObject({ replayed: true, machine: { id: admitted.machine.id } });
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: initialSeq + (viewer ? 1 : 2) });
            if (viewer) expect(await db.account.findUniqueOrThrow({ where: { id: viewer.id }, select: { seq: true } })).toEqual({ seq: viewerSeq + 2 });
            if (selectionKind === 'preset') {
                await expect(admitManagedAcquire({ ...request, input: { ...request.input, requestId: randomUUID() } }))
                    .rejects.toMatchObject({ code: 'preset_limit_reached' });
            }
        } finally {
            db.$transaction = originalTransaction;
            if (writerOutcome) for (const outcome of await writerOutcome) if (outcome.status === 'rejected') throw outcome.reason;
            vi.unstubAllEnvs();
            await db.managedMachine.deleteMany({ where: { custodianAccountId: account.id } });
            await db.managedMachinePreset.deleteMany({ where: { custodianAccountId: account.id } });
            await db.machine.deleteMany({ where: { accountId: account.id } });
            await db.account.delete({ where: { id: account.id } });
            if (viewer) await db.account.delete({ where: { id: viewer.id } });
        }
    });

    it('retains one complete installation identity when two registration fills race', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'guest' }),
            dataEncryptionKey: Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const proposals = [0, 1].map(() => {
            const keys = tweetnacl.sign.keyPair();
            const identity = { version: 1 as const, machineId: machine.id, accountId: account.id, installationId: randomUUID() };
            return { id: machine.id, metadata: machine.metadata, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                installationId: identity.installationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url'),
                installationProof: signMachineInstallationProof({ payload: identity, privateKey: keys.secretKey }) };
        });
        let captured!: () => void, release!: () => void;
        const firstRead = new Promise<void>(resolve => { captured = resolve; });
        const released = new Promise<void>(resolve => { release = resolve; });
        const transaction = db.$transaction;
        const pids: number[] = [];
        let paused = false;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            const options = args[1];
            // Home configuration's read snapshot is not either registration writer.
            if (typeof options === 'object' && options !== null && 'isolationLevel' in options
                && options.isolationLevel === 'RepeatableRead') return Reflect.apply(target, receiver, args);
            const index = pids.length;
            pids.push(0);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                pids[index] = backend.pid;
                if (index === 0) {
                    const find = tx.machine.findFirst.bind(tx.machine);
                    const findCurrent = new Proxy(find, { async apply(owner, receiver, values: Parameters<typeof find>) {
                        const row: unknown = await Reflect.apply(owner, receiver, values);
                        if (!paused && values[0]?.where?.id === machine.id) {
                            paused = true;
                            captured();
                            await released;
                        }
                        return row;
                    } });
                    const machines = new Proxy(tx.machine, { get(owner, property, receiver) {
                        return property === 'findFirst' ? findCurrent : Reflect.get(owner, property, receiver);
                    } });
                    return callback(new Proxy(tx, { get(owner, property, receiver) {
                        return property === 'machine' ? machines : Reflect.get(owner, property, receiver);
                    } }));
                }
                return callback(tx);
            }, ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const register = (payload: typeof proposals[number]) => app.inject({ method: 'POST', url: '/v1/machines',
                    headers: { 'x-test-user-id': account.id, 'x-happier-account-stored-content-protocol': '4' }, payload });
                const first = register(proposals[0]);
                const firstOutcome = Promise.allSettled([first]);
                let secondOutcome: typeof firstOutcome | undefined;
                try {
                    await Promise.race([firstRead, first.then(() => { throw new Error('Registration never read its current Machine'); })]);
                    let settled = false;
                    secondOutcome = Promise.allSettled([register(proposals[1])]).finally(() => { settled = true; });
                    while (!settled) {
                        const [state] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                            SELECT ${pids[0]} = ANY(pg_blocking_pids(${pids[1] ?? 0}::int)) AS blocked
                        `;
                        if (state.blocked) break;
                    }
                } finally { release(); }
                const outcomes = [...await firstOutcome, ...await secondOutcome ?? []];
                const responses = outcomes.map(outcome => {
                    if (outcome.status === 'rejected') throw outcome.reason;
                    return outcome.value;
                });
                expect(responses.map(response => response.statusCode).sort()).toEqual([200, 400]);
                const winningProposal = proposals[responses.findIndex(response => response.statusCode === 200)];
                const retained = await db.machine.findUniqueOrThrow({ where: { id: machine.id } });
                expect(retained.installationId).toBe(winningProposal.installationId);
                expect(Buffer.from(retained.installationPublicKey!).toString('base64url')).toBe(winningProposal.installationPublicKey);
            });
        } finally {
            release();
            db.$transaction = transaction;
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
