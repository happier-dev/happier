import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { db, initDbMysql, initDbPostgres } from '@/storage/db';

const provider = process.env.HAPPIER_DB_PROVIDER;
const available = provider === 'postgres' || provider === 'mysql';

describe('Automation subject and Action native persistence', () => {
    (available ? it : it.skip)('admits private matchers and reference-only consent without weakening Run evidence isolation', async () => {
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        const parameter = provider === 'mysql' ? '?' : '$1';
        const sql = (value: string) => provider === 'mysql' ? value : value.replaceAll('`', '"');
        const accountId = randomUUID();
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const consentId = randomUUID();
        const runId = randomUUID();
        const presenceRunId = randomUUID();
        const longActionId = `com.example/actions/${'a'.repeat(200)}`;
        try {
            await db.account.create({ data: { id: accountId, encryptionMode: 'plain' } });
            await db.automation.create({ data: { id: automationId, accountId, name: 'SQL migration fixture', templateCiphertext: 'opaque' } });
            await db.automationTrigger.create({ data: { id: triggerId, automationId, kind: 'action',
                definitionEnvelope: 'opaque private definition', actionId: longActionId, actionIdsJson: JSON.stringify([longActionId]), phase: 'after',
                subjectKind: 'machine', subjectKey: 'opaque-subject-digest' } });
            expect(await db.automationTrigger.findUnique({ where: { id: triggerId }, select: { actionId: true, actionIdsJson: true } }))
                .toEqual({ actionId: longActionId, actionIdsJson: JSON.stringify([longActionId]) });
            await db.automationTrigger.create({ data: { id: consentId, automationId, kind: 'action',
                consentForAutomationId: 'shared-workflow', consentForTriggerId: 'shared-trigger', consentedWorkflowRevision: 9 } });
            const occurredAt = new Date();
            await db.automationRun.create({ data: { id: runId, accountId, automationId, triggerId,
                state: 'succeeded', causeKind: 'trigger', causeTriggerKind: 'action', causeTriggerRevision: 0,
                causeOccurredAt: occurredAt, occurrenceKey: randomUUID(), causeActionEvidenceJson: '{"actionId":"session.stop","requestId":"request","phase":"after","status":"succeeded"}',
                scheduledAt: occurredAt, dueAt: occurredAt, resultEnvelopeBytes: new Uint8Array([0, 255, 1]) } });
            for (const mutation of [
                '`definitionEnvelope`=NULL', '`actionIdsJson`=\'[]\'', '`mode`=\'wait\'',
                '`subjectKey`=NULL', '`sourceSessionId`=\'raw-session\'',
                '`consentForAutomationId`=\'shared\',`consentForTriggerId`=\'shared-trigger\',`consentedWorkflowRevision`=9',
            ]) await expect(db.$executeRawUnsafe(sql(`UPDATE \`AutomationTrigger\` SET ${mutation} WHERE \`id\`=${parameter}`), triggerId)).rejects.toMatchObject({ code: 'P2010' });
            await expect(db.$executeRawUnsafe(sql(`UPDATE \`AutomationTrigger\` SET \`definitionEnvelope\`='private' WHERE \`id\`=${parameter}`), consentId)).rejects.toMatchObject({ code: 'P2010' });
            for (const mutation of ['`causeActionEvidenceJson`=NULL', '`causeActionEvidenceJson`=\'[]\'',
                '`causeSourceSessionId`=\'raw-session\'', '`triggerEvidenceEnvelope`=\'{}\'', '`causeTriggerKind`=NULL',
                '`causePluginEventEvidenceJson`=\'{}\'']) {
                await expect(db.$executeRawUnsafe(sql(`UPDATE \`AutomationRun\` SET ${mutation} WHERE \`id\`=${parameter}`), runId)).rejects.toMatchObject({ code: 'P2010' });
            }
            await db.automationRun.create({ data: { id: presenceRunId, accountId, automationId, triggerId,
                state: 'succeeded', causeKind: 'trigger', causeTriggerKind: 'pluginEvent', causeTriggerRevision: 0,
                causeOccurredAt: occurredAt, occurrenceKey: randomUUID(),
                causeEventPluginId: 'happier.machine.services', causeEventLocalId: 'machine-offline', causeSourceSelectorId: 'presence-source',
                causePluginEventEvidenceJson: JSON.stringify({ kind: 'machinePresence', payload: { serverId: 'home', machineId: 'machine',
                    transition: 'offline', revision: 1, observedAt: occurredAt.getTime() } }), scheduledAt: occurredAt, dueAt: occurredAt } });
            for (const mutation of ['`causeEventPluginId`=NULL', '`causeEventPluginId`=\'other-plugin\'', '`causeEventLocalId`=\'other-event\'',
                '`triggerEvidenceEnvelope`=\'{"t":"encrypted","c":"private"}\'', '`causeActionEvidenceJson`=\'{}\'']) {
                await expect(db.$executeRawUnsafe(sql(`UPDATE \`AutomationRun\` SET ${mutation} WHERE \`id\`=${parameter}`), presenceRunId)).rejects.toMatchObject({ code: 'P2010' });
            }
            if (provider === 'mysql') {
                // Document carriers use LONGTEXT, independently of short lookup leaves.
                const columns = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string; COLUMN_NAME: string; DATA_TYPE: string }>>(
                    `SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
                     AND ((TABLE_NAME='AutomationTrigger' AND COLUMN_NAME IN ('actionId','actionIdsJson')) OR (TABLE_NAME='AutomationRun' AND COLUMN_NAME IN ('causeActionEvidenceJson','causePluginEventEvidenceJson'))) ORDER BY TABLE_NAME,COLUMN_NAME`,
                );
                expect(columns).toEqual([
                    { TABLE_NAME: 'AutomationRun', COLUMN_NAME: 'causeActionEvidenceJson', DATA_TYPE: 'longtext' },
                    { TABLE_NAME: 'AutomationRun', COLUMN_NAME: 'causePluginEventEvidenceJson', DATA_TYPE: 'longtext' },
                    { TABLE_NAME: 'AutomationTrigger', COLUMN_NAME: 'actionId', DATA_TYPE: 'longtext' },
                    { TABLE_NAME: 'AutomationTrigger', COLUMN_NAME: 'actionIdsJson', DATA_TYPE: 'longtext' },
                ]);
            }
            await db.automationTrigger.update({ where: { id: triggerId }, data: { enabled: false, deletedAt: occurredAt,
                definitionEnvelope: null, actionId: null, actionIdsJson: null, phase: null, subjectKind: null, subjectKey: null } });
            expect(await db.automationRun.findUnique({ where: { id: runId }, select: { resultEnvelopeBytes: true } }))
                .toEqual({ resultEnvelopeBytes: new Uint8Array([0, 255, 1]) });
        } finally {
            await db.automationRun.deleteMany({ where: { id: { in: [runId, presenceRunId] }, accountId } });
            await db.automation.deleteMany({ where: { id: automationId, accountId } });
            await db.account.deleteMany({ where: { id: accountId } });
            await db.$disconnect();
        }
    });
});
