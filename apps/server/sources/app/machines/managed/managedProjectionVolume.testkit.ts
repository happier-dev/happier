import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { expect, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { ManagedAdmissionOutputV1Schema, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { db } from '@/storage/db';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import * as prisma from '@/storage/prisma';
import { createAuthenticatedRouteRequest } from '@/app/api/testkit/requestFixtures';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { createPluginAvailabilityOperations } from '@/app/plugins/availability/operations';
import { registerManagedMachineRoutes } from './managedRoutes';
import { resolveManagedDeclarationInTx, type StoredManagedMachine } from './managedRows';
import { admitManagedAcquire } from './managedAcquire';
import { PrismaClient } from '@prisma/client';

interface QueryMeasurement {
    model: string;
    method: string;
    milliseconds: number;
    bytes: number;
    rows: number;
    pluginIds: string[];
}

/** Observe real Prisma I/O; domain logic, query results and transaction options stay intact. */
async function measure<T>(phase: string, operation: () => Promise<T>) {
    const queries: QueryMeasurement[] = [];
    const original = db.$transaction;
    const start = performance.now();
    const observe = (tx: Tx): Tx => new Proxy(tx, {
        get(owner, property, txReceiver) {
            const delegate: unknown = Reflect.get(owner, property, txReceiver);
            if ((property === '$queryRaw' || property === '$queryRawUnsafe') && typeof delegate === 'function') return async (...input: unknown[]) => {
                const began = performance.now();
                const result: unknown = await Reflect.apply(delegate, owner, input);
                queries.push({ model: '$raw', method: String(property), milliseconds: performance.now() - began,
                    rows: Array.isArray(result) ? result.length : result === null ? 0 : 1,
                    bytes: 0, pluginIds: [] });
                return result;
            };
            if (typeof delegate === 'function') return delegate.bind(owner);
            if (typeof property !== 'string' || !/^[a-z][A-Za-z]+$/.test(property) || !delegate || typeof delegate !== 'object') return delegate;
            return new Proxy(delegate, {
                get(model, method, modelReceiver) {
                    const call: unknown = Reflect.get(model, method, modelReceiver);
                    if (typeof call !== 'function') return call;
                    return async (...input: unknown[]) => {
                        const began = performance.now();
                        const result: unknown = await Reflect.apply(call, model, input);
                        const milliseconds = performance.now() - began;
                        const rows: unknown[] = Array.isArray(result) ? result : [result];
                        queries.push({ model: property, method: String(method), milliseconds, rows: rows.filter(row => row !== null).length,
                            bytes: Buffer.byteLength(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? String(value) : value) ?? ''),
                            pluginIds: rows.flatMap(row => row && typeof row === 'object' && 'pluginId' in row && typeof row.pluginId === 'string' ? [row.pluginId] : []) });
                        return result;
                    };
                },
            });
        },
    });
    const snapshot = prisma.withSqliteReadSnapshot;
    const snapshotObservation = vi.spyOn(prisma, 'withSqliteReadSnapshot').mockImplementation(
        (read, options) => snapshot(tx => read(observe(tx)), options),
    );
    db.$transaction = new Proxy(original, {
        apply(target, receiver, args) {
            const callback: unknown = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(observe(tx)), ...args.slice(1)]);
        },
    });
    try {
        return { value: await operation(), queries };
    } finally {
        db.$transaction = original;
        snapshotObservation.mockRestore();
        const elapsedMs = performance.now() - start;
        const queryMs = queries.reduce((sum, query) => sum + query.milliseconds, 0);
        const summarize = (model: string) => {
            const selected = queries.filter(query => query.model === model);
            return { queryMs: selected.reduce((sum, query) => sum + query.milliseconds, 0),
                rows: selected.reduce((sum, query) => sum + query.pluginIds.length, 0),
                bytes: selected.reduce((sum, query) => sum + query.bytes, 0) };
        };
        console.info('managed-projection-volume', JSON.stringify({ phase, elapsedMs, queryMs,
            queries: queries.length, rows: queries.reduce((sum, query) => sum + query.rows, 0),
            statementGroups: queries.map(query => `${query.model}.${query.method}:${query.rows}`),
            outsideQueryMs: elapsedMs - queryMs,
            materializations: summarize('pluginMachineMaterialization'),
            intents: summarize('accountPluginIntent'), releases: summarize('accountPluginRelease') }));
    }
}

/** Use Prisma's ordered SQL event stream, including the transaction owner's raw publication work. */
async function measurePostgresCreate<T>(operation: () => Promise<T>) {
    const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    const statements: string[] = [];
    let finishBarrier: (() => void) | undefined;
    client.$on('query', event => {
        if (event.query.includes('managed_create_cost_barrier')) finishBarrier?.();
        else statements.push(event.query);
    });
    await client.$connect();
    const original = db.$transaction;
    // Rebind the genuine database boundary; admission, queries and publication stay real.
    db.$transaction = new Proxy(original, { apply(_owner, _receiver, args) {
        return Reflect.apply(client.$transaction, client, args);
    } });
    try {
        const start = performance.now();
        const value = await operation();
        const barrier = new Promise<void>(resolve => { finishBarrier = resolve; });
        await Promise.all([client.$queryRaw`SELECT 1 AS managed_create_cost_barrier`, barrier]);
        const groups: Record<string, number> = {};
        for (const sql of statements) {
            const key = sql.split(/\s+/, 2).join(' ');
            groups[key] = (groups[key] ?? 0) + 1;
        }
        console.info('managed-create-sql-cost', JSON.stringify({ elapsedMs: performance.now() - start,
            statements: statements.length, groups }));
        return { value, statements };
    } finally {
        db.$transaction = original;
        await client.$disconnect();
    }
}

/** A new admission selects its preset and provider, regardless of retained allocation volume. */
export async function exerciseManagedPresetAcquireCost() {
    const homeId = `srv_${'a'.repeat(32)}`;
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = { machineId: randomUUID(), installationId: randomUUID() };
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
        installationId: controller.installationId, pluginMaterializationRevision: 1n } });
    const manifest = await seedBundledManagedAvailability(account.id, homeId, controller, ['machine-lima.json']);
    const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Preset cost guest',
        choices: { store: '/tmp/cost-guests', image: 'fixture:image', arch: 'x86_64',
            vmType: 'qemu', cpus: 2, memoryGiB: 2, diskGiB: 10, mounts: [] } };
    const preset = await db.managedMachinePreset.create({ data: {
        id: randomUUID(), homeId, custodianAccountId: account.id, name: 'Cost preset', launch,
        controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
    } });
    const create = (requestId = randomUUID()) => admitManagedAcquire({ custodianAccountId: account.id, requesterAccountId: account.id,
        requestEnvelopeDigest: 'preset-cost-envelope', input: { requestId, continuationPresent: false,
            input: { enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' }, selection: { kind: 'preset',
                homeId, id: preset.id, revision: preset.revision },
                controller, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } } });
    const firstRequestId = randomUUID();
    const empty = await measurePostgresCreate(() => measure('preset-create-empty', () => create(firstRequestId)));
    // OPEN-S0B observed128 retained managed allocations. They must not be loaded by Create.
    await db.managedMachine.createMany({ data: Array.from({ length: 128 }, () => ({ homeId,
        custodianAccountId: account.id, controllerMachineId: controller.machineId,
        controllerInstallationId: controller.installationId, admittedActionRequestId: randomUUID(),
        admittedInput: {}, launch, allocation: 'confirmed-absent',
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false })) });
    const retained = await measurePostgresCreate(() => measure('preset-create-128-historical', create));
    expect(empty.value.value.replayed).toBe(false);
    expect(retained.value.value.replayed).toBe(false);
    expect(retained.value.value.machine.id).not.toBe(empty.value.value.machine.id);
    expect(retained.value.queries.length).toBe(empty.value.queries.length);
    // SET LOCAL refresh frequency can vary with elapsed time; actual data statements must not scale.
    const dataStatements = (statements: readonly string[]) => statements.filter(sql => /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/u.test(sql));
    expect(dataStatements(retained.statements).length).toBe(dataStatements(empty.statements).length);
    for (const result of [empty.value, retained.value]) {
        expect(result.queries.reduce((sum, query) => sum + query.rows, 0))
            .toBe(empty.value.queries.reduce((sum, query) => sum + query.rows, 0));
        expect([...new Set(result.queries.flatMap(query => query.pluginIds))]).toEqual([manifest.id]);
    }
    // A Prisma deadline is a database-boundary failure. Keep the real admission
    // and storage error classifier so this checks the caller-visible attribution.
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { apply() {
        return Promise.reject(Object.assign(new Error('A query cannot be executed on an expired transaction.'), { code: 'P2028' }));
    } });
    try {
        await expect(create()).rejects.toMatchObject({ code: 'database_transaction_timeout', transactionClass: 'managed-machine-acquire' });
        await expect(create(firstRequestId)).rejects.toMatchObject({ code: 'database_transaction_timeout', transactionClass: 'managed-machine-acquire-replay' });
    } finally {
        db.$transaction = original;
    }
}

/** Seed the actual bundled declaration/materialization volume on a disposable controller. */
export async function seedBundledManagedAvailability(accountId: string, homeId: string,
    controller: Readonly<{ machineId: string; installationId: string }>, filenames?: readonly string[]) {
    // Consume the generator-normalized declarations as fixture data, without
    // importing the CLI's source graph into the server compilation.
    const manifestDirectory = fileURLToPath(new URL('../../../../../cli/assets/bundled-plugin-manifests/', import.meta.url));
    const manifestFiles = (await readdir(manifestDirectory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.json') && (!filenames || filenames.includes(entry.name)))
        .map(entry => entry.name).sort();
    const manifests = await Promise.all(manifestFiles.map(async name =>
        PluginManifestV2Schema.parse(JSON.parse(await readFile(join(manifestDirectory, name), 'utf8')))));
    const manifest = manifests.find(candidate => candidate.id === 'happier.machine.lima');
    if (!manifest) throw new Error(`Missing bundled Lima manifest at ${manifestDirectory}`);
    console.info('managed-projection-fixture', JSON.stringify({ plugins: manifests.length,
        manifestBytes: manifests.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0) }));
    for (const candidate of manifests) {
        const declaration = createReleaseLessDeclarationV1(candidate);
        await db.accountPluginIntent.create({ data: { accountId, pluginId: candidate.id,
            enabled: true, writableCollections: [], releaseLessDeclaration: declaration } });
        await db.pluginMachineMaterialization.create({ data: { accountId, serverIdentityId: homeId,
            machineId: controller.machineId, materializationId: randomUUID(), pluginId: candidate.id, version: candidate.version,
            sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: declaration.manifestDigestSha256,
            uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: new Date() } });
    }
    // CREF-1 through CREF-9 are successive runtime generations on one installation,
    // not nine simultaneous full materialization inventories. Exercise the actual replacement owner.
    const availability = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }),
        resolveServerIdentityId: async () => homeId });
    const initialMaterializations = await db.pluginMachineMaterialization.findMany({ where: { machineId: controller.machineId } });
    for (let generation = 1; generation <= 9; generation += 1) {
        expect(await availability.reportMaterializations({ accountId, publisherMachineId: controller.machineId,
            input: { expectedRevision: generation, snapshot: { serverIdentityId: homeId, machineId: controller.machineId,
                materializations: initialMaterializations.map(row => ({ serverIdentityId: homeId, machineId: controller.machineId,
                    materializationId: `${generation}-${row.pluginId}`, pluginId: row.pluginId, version: row.version,
                    sourceClass: 'bundledFirstParty', portableRelease: false, archiveDigestSha256: row.archiveDigestSha256,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: Date.now() })) } } }))
            .toEqual({ outcome: 'replaced', revision: generation + 1 });
        expect(await db.pluginMachineMaterialization.count({ where: { machineId: controller.machineId } })).toBe(manifests.length);
    }
    return manifest;
}

/** Real bundled manifest volume, real managed HTTP handlers, real disposable storage. */
export async function exerciseManagedProjectionVolume() {
    const homeId = `srv_${'a'.repeat(32)}`;
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const controller = { machineId: randomUUID(), installationId: randomUUID() };
    await db.machine.create({ data: { id: controller.machineId, accountId: account.id, metadata: '{}',
        installationId: controller.installationId, pluginMaterializationRevision: 1n } });
    const manifest = await seedBundledManagedAvailability(account.id, homeId, controller);
    const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Volume guest',
        choices: { instance: 'volume-guest', store: '/tmp/volume-guests', image: 'fixture:image', arch: 'x86_64',
            vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Authentication is the substituted system boundary; all managed authority checks remain real.
    app.decorate('authenticate', async (request: FastifyRequest) => {
        Object.assign(request, createAuthenticatedRouteRequest({ userId: account.id,
            externalActionExecutionAuthorized: true, externalActionExecutionMachineId: controller.machineId,
            externalActionEffectActionId: 'machines.managed.acquire', externalActionExecutionRequestId: 'volume-create',
            externalActionExecutionRequestEnvelopeDigest: 'volume-admitted-envelope',
            externalActionExecutionCustodianAccountId: account.id }),
        { headers: request.headers, params: request.params, query: request.query });
    });
    registerManagedMachineRoutes(app);
    try {
        const rows: StoredManagedMachine[] = [];
        const lists: Array<{ count: number; value: Awaited<ReturnType<typeof app.inject>>; queries: QueryMeasurement[] }> = [];
        for (const count of [1, 4, 16]) {
            while (rows.length < count) {
                rows.push(await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
                    controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
                    admittedActionRequestId: randomUUID(), admittedInput: {}, launch,
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } }));
            }
            lists.push({ count, ...await measure(`list-${count}`, () => app.inject({ method: 'POST',
                url: '/v1/machines/managed/actions/list', payload: { homeId } })) });
        }
        const create = await measure('create', () => app.inject({ method: 'POST', url: '/v1/machines/managed/controller/admit', payload: {
            input: { selection: { kind: 'one-off', homeId, controller, launch,
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } },
            requestId: 'volume-create', continuationPresent: false,
        } }));
        const cancel = await measure('cancel', () => app.inject({ method: 'POST', url: '/v1/machines/managed/actions/cancel', payload: {
            homeId, managedId: rows[0].id, expectedIntentRevision: 0,
        } }));
        for (const list of lists) {
            expect(list.value.statusCode, list.value.body).toBe(200);
            expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(list.value.json()).machines).toHaveLength(list.count);
        }
        expect(create.value.statusCode, create.value.body).toBe(200);
        expect(ManagedAdmissionOutputV1Schema.parse(create.value.json())).toMatchObject({ replayed: false,
            machine: { allocation: 'unsubmitted', launch } });
        expect(cancel.value.statusCode, cancel.value.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.cancel'].parse(cancel.value.json()))
            .toMatchObject({ machine: { id: rows[0].id, creationState: 'canceled', allocation: 'confirmed-absent' } });
        expect(await db.managedMachine.count({ where: { custodianAccountId: account.id } })).toBe(17);
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: rows[0].id } }))
            .toMatchObject({ creationState: 'canceled', allocation: 'confirmed-absent', intentRevision: 1 });
        // Observable resource contract: unrelated plugin manifests must never enter a managed projection.
        // This distinguishes query pushdown from merely discarding unrelated results after loading them.
        for (const result of [...lists, create, cancel]) {
            const fetchedPluginIds = result.queries.flatMap(query => query.pluginIds);
            expect(fetchedPluginIds.length).toBeGreaterThan(0);
            expect([...new Set(fetchedPluginIds)]).toEqual([manifest.id]);
        }
        // Declaration transfer depends on the distinct provider/controller pair, not retained row count.
        const declarationBytes = (queries: QueryMeasurement[]) => queries
            .filter(query => query.model === 'accountPluginIntent' || query.model === 'accountPluginRelease')
            .reduce((sum, query) => sum + query.bytes, 0);
        expect(lists.map(list => declarationBytes(list.queries)))
            .toEqual(lists.map(() => declarationBytes(lists[0].queries)));
        // A retained row from an old installation must not inherit the current
        // installation's declared schema merely because its provider is the same.
        const orphan = await db.managedMachine.create({ data: { homeId, custodianAccountId: account.id,
            controllerMachineId: controller.machineId, controllerInstallationId: randomUUID(),
            admittedActionRequestId: randomUUID(), admittedInput: {},
            launch: { ...launch, choices: { retainedOldInstallation: true } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const retained = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list', payload: { homeId } });
        expect(retained.statusCode, retained.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(retained.json()).machines.find(row => row.id === orphan.id))
            .toMatchObject({ launch: { choices: { retainedOldInstallation: true } } });
        // Filtering and request-local reuse must retain installation, intent and trust currentness.
        const declarationInput = { homeId, custodianAccountId: account.id, controller, provider: launch.provider };
        const declaration = (input = declarationInput) => inReadSnapshot(tx => resolveManagedDeclarationInTx(tx, input));
        expect(await declaration()).toMatchObject({ schemaVersion: 1 });
        expect(await declaration({ ...declarationInput, controller: { ...controller, installationId: randomUUID() } })).toBeNull();
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { enabled: false } });
        expect(await declaration()).toBeNull();
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } }, data: { enabled: true } });
        await db.pluginMachineMaterialization.updateMany({ where: { machineId: controller.machineId, pluginId: manifest.id }, data: { trustState: 'untrusted' } });
        expect(await declaration()).toBeNull();
        // Re-reading after these writes must not reuse a declaration from a previous request.
        await db.managedMachine.update({ where: { id: rows[0].id }, data: { launch: { ...launch, choices: { retainedUnavailableProvider: true } } } });
        const unavailable = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list', payload: { homeId } });
        expect(unavailable.statusCode, unavailable.body).toBe(200);
        expect(ManagedMachineActionOutputSchemasV1['machines.managed.list'].parse(unavailable.json()).machines.find(row => row.id === rows[0].id))
            .toMatchObject({ launch: { choices: { retainedUnavailableProvider: true } } });
    } finally {
        await app.close();
    }
}
