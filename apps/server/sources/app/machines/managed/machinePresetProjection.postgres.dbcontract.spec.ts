import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { db, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { listMachinePresets } from './machinePresetService';
import { seedBundledManagedAvailability } from './managedProjectionVolume.testkit';

/** Counts real database reads while keeping authority, declarations and projection real. */
async function measurePresetReads<T>(operation: () => Promise<T>) {
    const reads = new Map<string, number>();
    const original = db.$transaction;
    db.$transaction = new Proxy(original, { apply(target, receiver, args) {
        const callback: unknown = args[0];
        if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [(tx: Tx) => callback(new Proxy(tx, { get(client, key, proxyReceiver) {
            const value: unknown = Reflect.get(client, key, proxyReceiver);
            if (!value || typeof value !== 'object' || !['machine', 'pluginMachineMaterialization', 'accountPluginIntent', 'accountPluginRelease'].includes(String(key))) {
                return typeof value === 'function' ? value.bind(client) : value;
            }
            return new Proxy(value, { get(model, method, modelReceiver) {
                const call: unknown = Reflect.get(model, method, modelReceiver);
                if (typeof call !== 'function') return call;
                return (...input: unknown[]) => {
                    if (String(method).startsWith('find')) reads.set(String(key), (reads.get(String(key)) ?? 0) + 1);
                    return Reflect.apply(call, model, input);
                };
            } });
        } })), ...args.slice(1)]);
    } });
    try { return { value: await operation(), reads }; }
    finally { db.$transaction = original; }
}

describe('preset projection cost on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!/^[a-f0-9]{64}$/.test(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID ?? '')
            || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('shares current controller and declaration reads across Account and delegated Team presets and observes withdrawal', async () => {
        const homeId = `srv_${'a'.repeat(32)}`;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: randomUUID(), installationId: randomUUID() };
        await db.machine.create({ data: { id: controller.machineId, accountId: owner.id, metadata: '{}', active: true,
            installationId: controller.installationId, installationPublicKey: new Uint8Array(tweetnacl.sign.keyPair().publicKey),
            pluginMaterializationRevision: 1n } });
        const manifest = await seedBundledManagedAvailability(owner.id, homeId, controller);
        const launch = { provider: { pluginId: manifest.id, localId: 'lima' }, schemaVersion: 1, name: 'Projected guest',
            choices: { instance: 'projection-guest', store: '/tmp/projection-guests', image: 'fixture:image', arch: 'x86_64',
                vmType: 'qemu', cpus: 2, memoryGiB: 4, diskGiB: 16, mounts: [] } };
        const team = await db.team.create({ data: { name: 'Projection cost' } });
        await db.teamMembership.createMany({ data: [{ teamId: team.id, accountId: owner.id, role: 'admin' },
            { teamId: team.id, accountId: member.id, role: 'member' }] });
        for (const collective of [false, true]) {
            await db.managedMachinePreset.createMany({ data: Array.from({ length: 128 }, () => ({
                id: randomUUID(), homeId, name: 'Projected preset', launch,
                ...(collective ? { teamId: team.id, teamAcquireDelegated: true } : { custodianAccountId: owner.id }),
                controllerMachineId: controller.machineId, controllerInstallationId: controller.installationId,
            })) });
        }
        const read = (collective: boolean) => measurePresetReads(() => listMachinePresets({
            accountId: collective ? member.id : owner.id, input: { homeId,
                owner: collective ? { kind: 'team', teamId: team.id } : { kind: 'account', accountId: owner.id } },
        }));
        for (const collective of [false, true]) {
            const result = await read(collective);
            console.info('preset-projection-reads', JSON.stringify({ collective, ...Object.fromEntries(result.reads) }));
            expect(result.value.kind).toBe('listed');
            if (result.value.kind !== 'listed') throw new Error('Expected listed presets');
            expect(result.value.presets).toHaveLength(128);
            if (collective) expect(result.value.presets.every(preset => preset.delegatedAcquire?.kind === 'ready')).toBe(true);
            expect(result.reads.get('machine') ?? 0).toBeLessThanOrEqual(3);
            expect(result.reads.get('pluginMachineMaterialization')).toBe(1);
            expect(result.reads.get('accountPluginIntent')).toBeLessThanOrEqual(2);
        }
        // A second phase fans the same declared provider out across many
        // controller installations; cost follows sets, not unique row count.
        const controllerIds = [controller.machineId, ...Array.from({ length: 127 }, () => randomUUID())];
        const sample = await db.machine.findUniqueOrThrow({ where: { id: controller.machineId } });
        await db.machine.createMany({ data: controllerIds.slice(1).map(id => ({ id, accountId: owner.id, metadata: '{}', active: true,
            installationId: randomUUID(), installationPublicKey: sample.installationPublicKey, pluginMaterializationRevision: 1n })) });
        const controllers = await db.machine.findMany({ where: { id: { in: controllerIds } } });
        const materialization = await db.pluginMachineMaterialization.findFirstOrThrow({ where: { machineId: controller.machineId, pluginId: manifest.id } });
        await db.pluginMachineMaterialization.createMany({ data: controllers.filter(row => row.id !== controller.machineId).map(row => ({
            ...materialization, id: randomUUID(), machineId: row.id, materializationId: randomUUID(),
        })) });
        for (const collective of [false, true]) {
            const presets = await db.managedMachinePreset.findMany({ where: collective ? { teamId: team.id } : { custodianAccountId: owner.id } });
            for (const [index, preset] of presets.entries()) {
                await db.managedMachinePreset.update({ where: { id: preset.id }, data: {
                    controllerMachineId: controllers[index]!.id, controllerInstallationId: controllers[index]!.installationId!,
                } });
            }
            const result = await read(collective);
            console.info('preset-projection-distinct-reads', JSON.stringify({ collective, ...Object.fromEntries(result.reads) }));
            expect(result.value.kind === 'listed' && result.value.presets.length).toBe(128);
            if (collective) expect(result.value.kind === 'listed' && result.value.presets.every(preset => preset.delegatedAcquire?.kind === 'ready')).toBe(true);
            expect(result.reads.get('machine') ?? 0).toBeLessThanOrEqual(3);
            expect(result.reads.get('pluginMachineMaterialization')).toBe(1);
            expect(result.reads.get('accountPluginIntent')).toBeLessThanOrEqual(2);
        }
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: owner.id, pluginId: manifest.id } }, data: { enabled: false } });
        const withdrawn = (await read(true)).value;
        expect(withdrawn.kind === 'listed' && withdrawn.presets.every(preset => preset.delegatedAcquire?.kind === 'unavailable'
            && preset.delegatedAcquire.code === 'provider_unavailable')).toBe(true);
        await db.accountPluginIntent.update({ where: { accountId_pluginId: { accountId: owner.id, pluginId: manifest.id } }, data: { enabled: true } });
        const restored = (await read(true)).value;
        expect(restored.kind === 'listed' && restored.presets.every(preset => preset.delegatedAcquire?.kind === 'ready')).toBe(true);
        await db.machine.updateMany({ where: { id: { in: controllerIds } }, data: { revokedAt: new Date() } });
        const retired = (await read(true)).value;
        expect(retired.kind === 'listed' && retired.presets.every(preset => preset.delegatedAcquire?.kind === 'unavailable'
            && preset.delegatedAcquire.code === 'controller_retired')).toBe(true);
    }, 120_000);
});
