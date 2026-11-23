import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MachineSetupSourcesApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { openManagedMachinePresetRecipientProjectionV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';

import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';

import { resolveMachineSetup } from './machineSetup';

describe('Plain Machine preset setup', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;

    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-plain-preset-', initAuth: false, initEncrypt: true });
    }, 120_000);

    afterAll(async () => { if (harness) await harness.close(); });

    it('round-trips an inert preset App through the keyless Plain setup projection', async () => {
        const accountId = 'preset-plain-setup-owner';
        const homeId = await getOrCreateServerIdentityId();
        const account = await db.account.create({ data: { id: accountId, encryptionMode: 'plain' },
            select: { encryptionMode: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true } });
        expect(account).toEqual({ encryptionMode: 'plain', publicKey: null, contentPublicKey: null, contentPublicKeySig: null });
        const target = await db.machine.create({ data: {
            id: 'preset-plain-setup-machine', accountId, metadata: '{}', installationId: 'preset-plain-setup-installation',
        } });
        const presetId = 'preset-plain-setup';
        const content = { t: 'plain' as const, v: { v: 1 as const, name: 'Plain setup preset',
            setup: { scripts: [{ body: 'echo plain setup' }], items: [{ kind: 'app' as const, definition: {
                name: 'Preset catalog App', project: { kind: 'create' }, bindings: [],
                definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'app', version: '1',
                    ref: { kind: 'version', version: '1' } } },
            } }] } } };
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        await app.ready();
        try {
            const saved = await app.inject({ method: 'POST', url: '/v1/machines/presets/create',
                headers: { 'x-test-user-id': accountId }, payload: {
                    homeId, id: presetId, owner: { kind: 'account', accountId }, contentEncryptionMode: 'plain',
                    content, recipients: [],
                } });
            expect(saved.statusCode, saved.body).toBe(200);
        } finally {
            await app.close();
        }
        expect(MachineSetupSourcesApplyInputV1Schema.safeParse({ homeId, machineId: target.id, sources: [
            { kind: 'accountPreset', presetId, presetRevision: 0, setup: content.v.setup },
            { kind: 'direct', setup: {} },
        ] }).success).toBe(false);

        const resolved = await resolveMachineSetup({ actorAccountId: accountId, custodianAccountId: accountId,
            input: { homeId, machineId: target.id, sources: [
                { kind: 'accountPresetOpaque' as const, presetId, presetRevision: 0, contentEncryptionMode: 'plain' },
                { kind: 'direct' as const, setup: {} },
            ] } });

        expect(resolved).toEqual({ sources: [
            { kind: 'accountPresetOpaque', presetId, presetRevision: 0, setupRevision: 0, contentEncryptionMode: 'plain',
                presetContent: { content, recipientEnvelope: null } },
            { kind: 'direct', setup: {} },
        ] });
        const source = resolved.sources[0];
        if (!source || source.kind !== 'accountPresetOpaque') throw new Error('Expected the admitted preset projection');
        expect(source).not.toHaveProperty('setup');
        expect(openManagedMachinePresetRecipientProjectionV1({ presetId, mode: 'plain', projection: source.presetContent }))
            .toEqual(content.v);
        expect(await db.deploymentEnvironment.count({ where: { createdByAccountId: accountId } })).toBe(0);
    });
});
