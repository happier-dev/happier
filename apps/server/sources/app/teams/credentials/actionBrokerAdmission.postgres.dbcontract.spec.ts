import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createReleaseLessDeclarationV1 } from '@/app/plugins/availability/currentDeclaration';
import { getMachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';
import { createTeamDirectActionMaterialFixture } from './directActionMaterial.testkit';
import { openTeamCredentialActionBroker } from './actionBrokerAdmission';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team Action broker Account lock scope (PostgreSQL)', () => {
    const previousEnv = new Map<string, string | undefined>();
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        for (const [key, value] of Object.entries({
            HANDY_MASTER_SECRET: 'team-action-lock-test',
            HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        })) {
            previousEnv.set(key, process.env[key]);
            process.env[key] = value;
        }
        await initEncrypt();
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        for (const [key, value] of previousEnv) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('admits a real Team broker grant without transferring declaration bodies under the Account fence', async () => {
        const shared = await createTeamDirectActionMaterialFixture({ deliveryMode: 'brokered' });
        if (!shared.broker) throw new Error('Missing fixture broker');
        const broker = shared.broker;
        const marker = 'team-broker-locked-declaration-body';
        const declaration = createReleaseLessDeclarationV1(PluginManifestV2Schema.parse({
            ...shared.manifest, metadata: { measuredBody: marker + 'x'.repeat(128 * 1024) },
        }));
        // Reuse the retained V2 multi-Machine stress shape from the declaration cost contracts.
        await db.accountPluginIntent.update({ where: { accountId_pluginId: {
            accountId: shared.recipient.id, pluginId: shared.manifest.id,
        } }, data: { releaseLessDeclaration: { schemaVersion: 2,
            machines: Array.from({ length: 490 }, (_, index) => ({
                machineId: index === 489 ? shared.machine.id : `unrelated-machine-${index}`,
                machineInstallationId: `installation-${index}`, declaration,
            })), legacyDeclaration: null } } });
        const results: Array<{ held: boolean; value: unknown }> = [];
        let fences = 0;
        const transaction = db.$transaction;
        // Observe the real database adapter; admission and declaration resolution stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => {
                let held = false;
                const observe = async (owner: object, method: (...values: unknown[]) => unknown, values: unknown[]) => {
                    const value = await Reflect.apply(method, owner, values);
                    const query = values[0] as string | { text?: string; sql?: string } | undefined;
                    const sql = typeof query === 'string' ? query : query?.text ?? query?.sql ?? '';
                    if (/FROM "Account".*FOR NO KEY UPDATE/s.test(sql)) { held = true; fences++; }
                    results.push({ held, value });
                    return value;
                };
                return await callback(new Proxy(tx, { get(owner, key, receiver) {
                    const value = Reflect.get(owner, key, receiver);
                    if (typeof value === 'function' && String(key).startsWith('$')) {
                        return (...values: unknown[]) => observe(owner, value, values);
                    }
                    if (value && typeof value === 'object' && !String(key).startsWith('_')) {
                        return new Proxy(value, { get(delegate, method, receiver) {
                            const operation = Reflect.get(delegate, method, receiver);
                            return typeof operation === 'function'
                                ? (...values: unknown[]) => observe(delegate, operation, values) : operation;
                        } });
                    }
                    return value;
                } }));
            }, ...args.slice(1)]);
        } });
        try {
            const opened = await openTeamCredentialActionBroker({
                actorAccountId: shared.recipient.id, rootActionId: shared.consumer.actionId,
                authentication: readSessionAccessAuthenticationFromRequest({ authAuthority: 'present_user', authTokenAuthenticationEvidence: [] }),
                request: { v: 3, resourceId: shared.resource.id, initiatorMachineId: shared.machine.id,
                    consumer: shared.consumer, inputDigest: computeActionInputApprovalDigestV1(shared.consumer.actionId, {}) },
                readCurrentPresence: async () => {
                    const presence = async (accountId: string, machineId: string) => await getMachineDaemonPresenceInventory({
                        accountId, machineIds: [machineId], io: { in: () => ({ fetchSockets: async () => [
                            { data: { clientType: 'machine-scoped', userId: accountId, machineId } },
                        ] }) },
                    });
                    return { initiatorPresence: await presence(shared.recipient.id, shared.machine.id),
                        brokerPresence: await presence(shared.custodian.id, broker.id) };
                },
                nowMs: Date.now(), grantId: crypto.randomUUID(),
                signingKey: { keyId: 'test-home', secretKey: nacl.sign.keyPair().secretKey },
            });
            expect(opened).toMatchObject({ ok: true });
            expect(fences, 'The real admission must exercise the Account serialization fence').toBeGreaterThan(0);
            // Count transferred bodies after closure, so measurement adds no serialization work under the lock.
            const lockedBodies = results.filter(result => result.held).reduce((count, result) => count
                + (JSON.stringify(result.value, (_key, value) => typeof value === 'bigint' ? String(value) : value) ?? '')
                    .split(marker).length - 1, 0);
            expect(lockedBodies, 'Declaration bodies must be prepared before Account serialization').toBe(0);
        } finally {
            db.$transaction = transaction;
        }
    });
});
