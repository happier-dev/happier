import { db } from '@/storage/db';
import { prismaRuntime } from '@/storage/prisma';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { workflowRunSqlIdentifier } from '@/app/workflows/workflowRunAttention';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import type { AutomationDefinitionDetail } from '@happier-dev/protocol/automations/automationApiV3';

type ScheduleOccurrences = NonNullable<AutomationDefinitionDetail['scheduleOccurrences']>;

/** Saved schedule revision and its actual latest due occurrence; no content is opened. */
export async function loadAutomationScheduleOccurrences(accountId: string, automationIds: readonly string[], now = Date.now()): Promise<Map<string, ScheduleOccurrences>> {
    const result = new Map<string, ScheduleOccurrences>();
    const id = workflowRunSqlIdentifier;
    type Row = { automationId: string; triggerId: string; triggerRevision: number; scheduledFor: Date | bigint | number;
        startedAt: Date | bigint | number | null; state: string };
    const timestamp = (value: Date | bigint | number) => value instanceof Date ? value.getTime() : Number(value);
    for (const page of portableQueryChunks({ values: automationIds, bindingsPerValue: 1, fixedBindings: 2 })) {
        const rows = await db.$queryRaw<Row[]>(prismaRuntime.sql`
            WITH ranked AS (
                SELECT r.${id('automationId')} AS ${id('automationId')}, r.${id('triggerId')} AS ${id('triggerId')},
                    t.${id('revision')} AS ${id('triggerRevision')}, r.${id('causeScheduledFor')} AS ${id('scheduledFor')},
                    r.${id('startedAt')} AS ${id('startedAt')}, r.${id('state')} AS ${id('state')},
                    ROW_NUMBER() OVER (PARTITION BY r.${id('triggerId')}
                        ORDER BY r.${id('causeScheduledFor')} DESC, r.${id('createdAt')} DESC, r.${id('id')} DESC) AS ordinal
                FROM ${id('AutomationRun')} r JOIN ${id('AutomationTrigger')} t ON t.${id('id')} = r.${id('triggerId')}
                    AND t.${id('automationId')} = r.${id('automationId')}
                    AND t.${id('revision')} = r.${id('causeTriggerRevision')}
                WHERE r.${id('accountId')} = ${accountId}
                    AND r.${id('automationId')} IN (${prismaRuntime.join([...page])})
                    AND r.${id('originKind')} = 'automation' AND r.${id('causeKind')} = 'trigger'
                    AND r.${id('causeTriggerKind')} = 'schedule' AND t.${id('deletedAt')} IS NULL
                    AND r.${id('causeScheduledFor')} <= ${new Date(now)}
            ) SELECT ${id('automationId')}, ${id('triggerId')}, ${id('triggerRevision')}, ${id('scheduledFor')},
                ${id('startedAt')}, ${id('state')} FROM ranked WHERE ordinal = 1`);
        for (const row of rows) {
            const occurrences = result.get(row.automationId) ?? [];
            occurrences.push({ triggerId: AutomationTriggerIdSchema.parse(row.triggerId), triggerRevision: row.triggerRevision,
                scheduledFor: timestamp(row.scheduledFor),
                startedAt: row.startedAt === null ? null : timestamp(row.startedAt), held: row.state === 'waiting_for_review' });
            result.set(row.automationId, occurrences);
        }
    }
    return result;
}
