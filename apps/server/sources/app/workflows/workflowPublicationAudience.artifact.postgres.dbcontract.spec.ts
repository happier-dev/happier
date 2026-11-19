import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { markAutomationChangedTx } from '@/app/automations/automationCrudService';
import { resolveArtifactAudienceInTx } from '@/app/artifacts/artifactAccessService';
import { acquireWorkflowPublicationLocksInTx } from './acquireWorkflowPublicationLocksInTx';
import { getWorkflowPublicationAudienceInTx } from './workflowPublicationAudience';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Workflow Artifact publication audience', () => {
    let ownerId: string;
    let readerId: string;
    let outsiderId: string;
    let workflowId: string;

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        const createAccount = async () => (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
        [ownerId, readerId, outsiderId] = await Promise.all([createAccount(), createAccount(), createAccount()]);
        workflowId = randomUUID();
        await db.artifact.create({ data: { id: workflowId, accountId: ownerId,
            header: Buffer.from(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }), 'base64'),
            body: Buffer.from(encodePlainArtifactStoredContent({}), 'base64'),
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        await db.artifactGrant.create({ data: { artifactId: workflowId, principalKind: 'account',
            accountId: readerId, accessLevel: 'view', createdByAccountId: ownerId } });
    });
    afterAll(async () => { await shutdownDbClient(); });

    function scope(automationId: string) {
        return { accountId: ownerId, automationIds: [automationId], automationDefinitionWrite: {
            id: automationId, accountId: ownerId, workflowDefinitionId: workflowId, scopeSessionId: null,
        } };
    }

    it('admits the same direct Artifact readers as Action-index publication without a selected Team', async () => {
        const audience = await inReadSnapshot(tx => getWorkflowPublicationAudienceInTx(tx, scope(randomUUID())));
        const publishedAudience = await inReadSnapshot(tx => resolveArtifactAudienceInTx(tx, workflowId));
        expect(publishedAudience).toEqual([ownerId, readerId].sort());
        expect(audience.accountIds).toEqual(publishedAudience);
        expect(audience.accountIds).not.toContain(outsiderId);
    });

    it.each(['create', 'add'] as const)('commits the %s trigger transaction and publishes the reader cursor without replay exhaustion', async operation => {
        const automationId = randomUUID();
        if (operation === 'add') await db.automation.create({ data: { id: automationId, accountId: ownerId,
            workflowDefinitionId: workflowId, name: 'Existing Workflow', templateCiphertext: 'private definition' } });
        const before = await db.account.findUniqueOrThrow({ where: { id: readerId }, select: { seq: true } });
        const triggerId = randomUUID();
        // The approved Action enters this same admission -> write -> publication transaction.
        // Retain the real PostgreSQL fences and publisher: an omitted reader exhausts inTx replay.
        await inTx(async tx => {
            await acquireWorkflowPublicationLocksInTx(tx, scope(automationId));
            const previous = await tx.automation.findUnique({ where: { id: automationId }, include: { triggers: true } });
            const trigger = { id: triggerId, kind: 'action' as const,
                actionIdsJson: JSON.stringify(['machines.command.run']), phase: 'before', mode: 'wait', onFailure: 'ask',
                definitionEnvelope: 'private trigger', reachesOthers: true, subjectKind: 'machine',
                subjectKey: automationSubjectKeyV1({ kind: 'machine', serverId: randomUUID(), machineId: randomUUID() }),
            };
            const current = previous
                ? await tx.automation.update({ where: { id: automationId }, data: { triggers: { create: trigger } }, include: { triggers: true } })
                : await tx.automation.create({ data: { id: automationId, accountId: ownerId, workflowDefinitionId: workflowId,
                    name: 'Approved check', templateCiphertext: 'private definition', triggers: { create: trigger } }, include: { triggers: true } });
            await markAutomationChangedTx(tx, { accountId: ownerId, automationId, publication: { previous, current } });
        });
        expect(await db.automationTrigger.findUnique({ where: { id: triggerId }, select: { automationId: true } }))
            .toEqual({ automationId });
        const changed = await db.accountChange.findFirst({ where: { accountId: readerId, kind: 'artifact', entityId: workflowId } });
        expect(changed?.cursor).toBeGreaterThan(before.seq);
        expect(await db.accountChange.findFirst({ where: { accountId: outsiderId, entityId: workflowId } })).toBeNull();
    });

    it('admits former and new readers when replacing the linked Workflow', async () => {
        const automation = await db.automation.findFirstOrThrow({ where: { accountId: ownerId, workflowDefinitionId: workflowId },
            include: { triggers: true } });
        const artifact = await db.artifact.findUniqueOrThrow({ where: { id: workflowId } });
        const replacementId = randomUUID();
        await db.artifact.create({ data: { id: replacementId, accountId: ownerId,
            header: artifact.header, body: artifact.body, dataEncryptionKey: artifact.dataEncryptionKey } });
        await db.artifactGrant.create({ data: { artifactId: replacementId, principalKind: 'account',
            accountId: outsiderId, accessLevel: 'view', createdByAccountId: ownerId } });
        const before = await db.account.findMany({ where: { id: { in: [readerId, outsiderId] } }, select: { id: true, seq: true } });
        await inTx(async tx => {
            const publicationScope = scope(automation.id);
            publicationScope.automationDefinitionWrite.workflowDefinitionId = replacementId;
            await acquireWorkflowPublicationLocksInTx(tx, publicationScope);
            const current = await tx.automation.update({ where: { id: automation.id },
                data: { workflowDefinitionId: replacementId }, include: { triggers: true } });
            await markAutomationChangedTx(tx, { accountId: ownerId, automationId: automation.id,
                publication: { previous: automation, current } });
        });
        for (const account of before) {
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).seq)
                .toBeGreaterThan(account.seq);
        }
    });
});
