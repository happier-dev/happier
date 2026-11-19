import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { readArtifactAccountEncryptionMigrationRowsInTx, migrateArtifactAccountEncryptionInTx } from './artifactWriteService';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'artifact-action-conversion-', initEncrypt: true }); }, 180_000);
afterAll(async () => { if (harness) await harness.close(); });

it('converts every author’s Workflow Action content atomically with its Artifact, retaining bindings and Account carriers', async () => {
    // Socket delivery is the network boundary; conversion and publication remain real.
    const events = vi.spyOn(eventRouter, 'emitUpdate').mockImplementation(() => {});
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee' } });
    const author = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    const artifactId = randomUUID();
    const subject = { kind: 'approvalProfile' as const, serverId: 'server', profileId: artifactId };
    await db.artifact.create({ data: { id: artifactId, accountId: owner.id, headerVersion: 1, bodyVersion: 1, header: Buffer.from([2, 1]),
        body: Buffer.from([2, 2]), dataEncryptionKey: Buffer.from([3, 4]) } });
    await db.artifactGrant.create({ data: { artifactId, principalKind: 'account', accountId: reader.id,
        accessLevel: 'view', createdByAccountId: owner.id } });
    const shared: { automationId: string; triggerId: ReturnType<typeof AutomationTriggerIdSchema.parse>; triggerRevision: number;
        content: { t: 'encrypted'; c: string } }[] = [];
    let privateTriggerId = '';
    for (const accountId of [owner.id, author.id]) {
        const automationId = randomUUID();
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const content = { t: 'encrypted' as const, c: `artifact-content-${accountId}` };
        shared.push({ automationId, triggerId, triggerRevision: 3, content });
        privateTriggerId = randomUUID();
        await db.automation.create({ data: { id: automationId, accountId, workflowDefinitionId: artifactId,
            name: 'Workflow check', enabled: true, templateCiphertext: '{}',
            triggers: { create: [
                { id: triggerId, kind: 'action', revision: 3, actionIdsJson: '["session.stop"]', phase: 'after',
                    subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject), reachesOthers: true,
                    definitionEnvelope: JSON.stringify({ t: 'workflow', revision: { headerVersion: 1, bodyVersion: 1 }, content }) },
                { id: privateTriggerId, kind: 'action', actionIdsJson: '["session.stop"]', phase: 'after',
                    definitionEnvelope: JSON.stringify({ t: 'encrypted', c: 'account-content' }) },
            ] } } });
    }
    shared.sort((a, b) => a.automationId.localeCompare(b.automationId) || a.triggerId.localeCompare(b.triggerId));
    const row = (await readArtifactAccountEncryptionMigrationRowsInTx(db, owner.id))[0]!;
    expect(row).toMatchObject({ actionTriggerDefinitions: shared });
    const target = shared.map(item => ({ ...item, content: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, automationId: item.automationId, triggerId: item.triggerId, triggerRevision: item.triggerRevision, triggerKind: 'action' },
        definition: { kind: 'action', actionIds: ['session.stop'], phase: 'after', subject,
            filter: { v: 1, all: [{ field: '/result/ok', op: 'eq', value: true }] } } }) }));
    const item = { artifactId, expectedHeaderVersion: row.headerVersion, expectedBodyVersion: row.bodyVersion,
        expectedDataEncryptionKey: Buffer.from(row.dataEncryptionKey).toString('base64'),
        header: encodePlainArtifactStoredContent({ title: 'Workflow' }), body: encodePlainArtifactStoredContent({ body: 'Workflow' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], blobs: [], revisions: [] };
    const options = { accountId: owner.id, fromMode: 'e2ee' as const, toMode: 'plain' as const, markChanged: async () => 1 };
    expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ ...options, tx, directive: { action: 'migrate', items: [item] } })))
        .toEqual({ status: 'migration_incomplete' });
    const directive = { action: 'migrate' as const, items: [{ ...item, actionTriggerDefinitions: { expected: shared, target } }] };
    for (const invalidTarget of [target.slice(1), target.map(entry => ({ ...entry, triggerRevision: entry.triggerRevision + 1 })),
        shared, target.map(entry => ({ ...entry, content: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, automationId: entry.automationId, triggerId: entry.triggerId, triggerRevision: entry.triggerRevision + 1, triggerKind: 'action' },
            definition: { kind: 'action', actionIds: ['session.stop'], phase: 'after', subject } }) }))]) {
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ ...options, tx, directive: { action: 'migrate',
            items: [{ ...item, actionTriggerDefinitions: { expected: shared, target: invalidTarget } }] } })))
            .toEqual({ status: 'migration_incomplete' });
    }
    const rollback = new Error('transaction-control');
    await expect(inTx(async tx => {
        expect(await migrateArtifactAccountEncryptionInTx({ ...options, tx, directive })).toEqual({ status: 'applied' });
        throw rollback;
    })).rejects.toBe(rollback);
    expect((await readArtifactAccountEncryptionMigrationRowsInTx(db, owner.id))[0]).toMatchObject({ actionTriggerDefinitions: shared,
        headerVersion: row.headerVersion, dataEncryptionKey: row.dataEncryptionKey });
    expect(events.mock.calls).toEqual([]);
    expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ ...options, tx, directive }))).toEqual({ status: 'applied' });
    expect((await readArtifactAccountEncryptionMigrationRowsInTx(db, owner.id))[0]).toMatchObject({ actionTriggerDefinitions: target,
        headerVersion: row.headerVersion + 1 });
    expect((await db.automationTrigger.findUniqueOrThrow({ where: { id: privateTriggerId } })).definitionEnvelope)
        .toBe(JSON.stringify({ t: 'encrypted', c: 'account-content' }));
    for (const entry of target) {
        expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: entry.triggerId } })).toMatchObject({ revision: 3,
            definitionEnvelope: JSON.stringify({ t: 'workflow', revision: { headerVersion: 2, bodyVersion: 2 }, content: entry.content }) });
        expect(events.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({ userId: reader.id,
            payload: expect.objectContaining({ body: expect.objectContaining({ t: 'automation-upsert',
                actionIndex: { automationId: entry.automationId, rows: [expect.objectContaining({ triggerId: entry.triggerId,
                    workflowRevision: row.bodyVersion + 1, sharedDefinitionEnvelope: entry.content })] } }) }) }));
    }
    events.mockRestore();
});
