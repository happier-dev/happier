import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import type { WorkflowRunLastStartedSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { AutomationActionTrigger } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { appendBoundedPage, summarizeWorkflowRuns } from '@/app/workflows/workflowRunService';
import { automationSubjectKeyV1, type AutomationSubjectV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS } from '@happier-dev/protocol/automations/automationApiV3';
import { summarizeWorkflowTriggerInputsV1, type WorkflowAttachedTriggerPageV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { parseWorkflowDefinitionRefV1 } from '@happier-dev/protocol/workflows/workflowDefinitionRefV1';
import { ACCOUNT_DISPLAY_PROFILE_SELECT, resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import { inTx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { automationTriggerListItemSelect } from './automationPersistenceSelect';
import { automationActionTriggerConfigurationSelect } from './automationActionTriggerConfiguration';
import { toAutomationTriggerSummaryProjection } from './automationApiProjection';
import { readAutomationActorConsentReferencesInTx, readWorkflowSummaryArtifactAccessInTx, type WorkflowSummaryArtifactAccess } from './automationSharedWorkflowSummaries';
import { loadAutomationEventStatusProjections } from './automationEventStatusProjection';
import { loadAutomationSessionLifecycleStatusProjections } from './automationSessionLifecycleStatusProjection';
import type { AutomationTriggerSummarySource } from './automationTypes';
import { canProjectSharedAutomationTriggerSummary } from './automationActionIndex';

const { definitionEnvelope: _privateEnvelope, ...summaryTriggerSelect } = automationTriggerListItemSelect;

export type AutomationAttachedTriggerSelection = Readonly<{
    accountId: string;
    limit?: number;
    cursor?: string | null;
} & ({ subject: AutomationSubjectV1; contextSubjects?: readonly AutomationSubjectV1[] }
    | { actionId: string; phase: AutomationActionTrigger['phase'] })>;

/** Structural selection owns direct/context discovery and its page-independent denied count. */
export async function listAutomationAttachedTriggers(params: AutomationAttachedTriggerSelection): Promise<WorkflowAttachedTriggerPageV1> {
    const directKey = 'subject' in params ? automationSubjectKeyV1(params.subject) : null;
    const subjects = 'subject' in params
        ? new Map([params.subject, ...(params.contextSubjects ?? [])].map(subject => [automationSubjectKeyV1(subject), subject]))
        : new Map<string, AutomationSubjectV1>();
    const limit = Math.min(Math.max(Math.floor(params.limit ?? AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS), 1), AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS);
    const { page, actorReferences } = await inTx(async tx => {
        // First stage is structural identity only. No body or audience census is loaded.
        // The aggregate necessarily visits matching references, never unrelated definitions.
        const readSubjectCandidates = async (cursor: string | null) => {
            const common = {
                deletedAt: null, consentForAutomationId: null,
                ...(cursor === null ? {} : { id: { gt: cursor } }),
            };
            const selection = {
                select: { id: true, subjectKind: true, subjectKey: true, reachesOthers: true,
                    automation: { select: { id: true, accountId: true, workflowDefinitionId: true, scopeSessionId: true } } },
                orderBy: { id: 'asc' as const },
                take: AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS,
            } as const;
            // Keep Account matching separate to preserve the indexed subject branches.
            const [subjectsPage, accountPage] = await Promise.all([
                tx.automationTrigger.findMany({
                    where: { ...common, OR: [...subjects].map(([subjectKey, subject]) => ({ subjectKind: subject.kind, subjectKey })),
                        automation: { deletedAt: null } },
                    ...selection,
                }),
                'subject' in params && params.subject.kind === 'session'
                    ? tx.automationTrigger.findMany({
                        where: { ...common, kind: 'sessionLifecycle', subjectKind: null, subjectKey: null,
                            definitionEnvelope: { not: null }, automation: { accountId: params.accountId, deletedAt: null } },
                        ...selection,
                    }) : [],
            ]);
            return [...subjectsPage, ...accountPage].sort((left, right) => left.id.localeCompare(right.id))
                .slice(0, AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS);
        };
        const readCandidates = async (cursor: string | null): Promise<Awaited<ReturnType<typeof readSubjectCandidates>>> => {
            if (!('actionId' in params)) return readSubjectCandidates(cursor);
            const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
            // Match the complete structural selector. The singleton actionId leaf
            // cannot answer a multi-Action lookup. PostgreSQL's phase-specific GIN
            // indexes cover this exact expression and live matching-row predicate.
            const binds: unknown[] = [];
            const bind = (value: unknown) => { binds.push(value); return dialect === 'postgres' ? `$${binds.length}` : '?'; };
            const membership = dialect === 'postgres'
                ? `t."actionIdsJson"::jsonb @> ${bind(JSON.stringify([params.actionId]))}::jsonb`
                : dialect === 'mysql'
                    ? `JSON_CONTAINS(t."actionIdsJson", JSON_QUOTE(${bind(params.actionId)}))`
                    : `EXISTS (SELECT 1 FROM json_each(t."actionIdsJson") selected_action WHERE selected_action.value = ${bind(params.actionId)})`;
            const sql = `SELECT t."id", t."subjectKind", t."subjectKey", t."reachesOthers",
                a."id" AS "automationId", a."accountId", a."workflowDefinitionId", a."scopeSessionId"
                FROM "AutomationTrigger" t JOIN "Automation" a ON a."id" = t."automationId"
                WHERE t."kind" = 'action' AND t."deletedAt" IS NULL AND t."consentForAutomationId" IS NULL
                  AND t."phase" = '${params.phase === 'before' ? 'before' : 'after'}' AND ${membership}
                  AND a."deletedAt" IS NULL ${cursor === null ? '' : `AND t."id" > ${bind(cursor)}`}
                ORDER BY t."id" ASC LIMIT ${bind(AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS)}`;
            type Candidate = Awaited<ReturnType<typeof readSubjectCandidates>>[number];
            const rows = await tx.$queryRawUnsafe<Array<Pick<Candidate, 'id' | 'subjectKind' | 'subjectKey' | 'reachesOthers'>
                & Candidate['automation'] & { automationId: string }>>(dialect === 'mysql' ? sql.replaceAll('"', '`') : sql, ...binds);
            return rows.map(({ automationId, accountId, workflowDefinitionId, scopeSessionId, ...row }) => ({ ...row,
                reachesOthers: Boolean(row.reachesOthers), automation: { id: automationId, accountId, workflowDefinitionId, scopeSessionId } }));
        };
        const page: Awaited<ReturnType<typeof readCandidates>> = [];
        const workflowAccess = new Map<string, WorkflowSummaryArtifactAccess>();
        let skippedNotSharedCount = 0;
        let candidateCursor: string | null = null;
        for (;;) {
          const candidates = await readCandidates(candidateCursor);
          if (candidates.length === 0) break;
          const scoped = candidates.filter(row => row.automation.accountId === params.accountId
            || (canProjectSharedAutomationTriggerSummary(row.automation, row) && row.automation.workflowDefinitionId !== null));
          const visible = await readWorkflowSummaryArtifactAccessInTx(tx, { accountId: params.accountId,
            workflowDefinitionIds: [...new Set(scoped.flatMap(row => {
                const ref = parseWorkflowDefinitionRefV1(row.automation.workflowDefinitionId);
                return ref?.kind === 'artifact' ? [ref.artifactId] : [];
            }))] });
          const admitted = scoped.filter(row => {
            const workflow = row.automation.workflowDefinitionId;
            if (workflow === null) return row.automation.accountId === params.accountId;
            const ref = parseWorkflowDefinitionRefV1(workflow);
            return ref?.kind === 'artifact' ? visible.has(ref.artifactId) : row.automation.accountId === params.accountId;
          });
          skippedNotSharedCount += scoped.length - admitted.length;
          for (const row of admitted) {
            if ((!params.cursor || row.id > params.cursor) && page.length <= limit) {
                page.push(row);
                const ref = parseWorkflowDefinitionRefV1(row.automation.workflowDefinitionId);
                const access = ref?.kind === 'artifact' ? visible.get(ref.artifactId) : undefined;
                if (access) workflowAccess.set(row.id, access);
            }
          }
          if (candidates.length < AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS) break;
          candidateCursor = candidates.at(-1)!.id;
        }
        const selected = page.slice(0, limit);
        if (selected.length === 0) return { page: { attached: [], nextCursor: null, skippedNotSharedCount }, actorReferences: [] };
        const ids = selected.map(row => row.id);
        const rows = await tx.automation.findMany({ where: { id: { in: [...new Set(selected.map(row => row.automation.id))] } },
            select: { id: true, accountId: true, workflowDefinitionId: true, enabled: true,
                triggers: { where: { deletedAt: null, id: { in: ids } },
                    select: { ...summaryTriggerSelect, ...automationActionTriggerConfigurationSelect } },
                account: { select: ACCOUNT_DISPLAY_PROFILE_SELECT } } });
        const sources: AutomationTriggerSummarySource[] = rows;
        const [events, lifecycle] = await Promise.all([
            loadAutomationEventStatusProjections({ automations: sources }),
            loadAutomationSessionLifecycleStatusProjections({ automations: sources, tx }),
        ]);
        const sourcesById = new Map(sources.map(source => [source.id, source]));
        const factsById = new Map(selected.map(row => [row.id, row]));
        const attached: WorkflowAttachedTriggerPageV1['attached'] = [];
        for (const row of rows) {
            const source = sourcesById.get(row.id)!;
            const projection = { id: row.id, enabled: row.enabled, triggers: source.triggers.map(trigger =>
                toAutomationTriggerSummaryProjection(trigger, events, lifecycle.get(row.id) ?? new Map())) };
            const summaries = new Map(summarizeWorkflowTriggerInputsV1(projection).triggers.map(summary => [summary.triggerId, summary]));
            for (const trigger of row.triggers) {
                const fact = factsById.get(trigger.id);
                const triggerSummary = summaries.get(trigger.id);
                if (!fact || !triggerSummary) continue;
                // Another Account's authored operand stays private; relation is already selected.
                const safeSummary = row.accountId !== params.accountId && triggerSummary.kind === 'action'
                    ? (({ subjectKind: _subjectKind, subjectKey: _subjectKey, ...summary }) => summary)(triggerSummary) : triggerSummary;
                attached.push({ automationId: row.id, triggerId: trigger.id, workflowDefinitionId: row.workflowDefinitionId,
                    revision: trigger.revision, enabled: row.enabled && trigger.enabled,
                    relation: directKey === null || fact.subjectKey === directKey ? 'direct' : 'context', summary: safeSummary,
                    ...(workflowAccess.has(trigger.id) ? { workflowAccess: workflowAccess.get(trigger.id)! } : {}),
                    ...(trigger.kind === 'pluginEvent' ? { sourceStatus: events.get(trigger.id)?.sourceStatus ?? null,
                        sourceCatalogStatus: events.get(trigger.id)?.sourceCatalogStatus ?? null } : {}),
                    setUpBy: { accountId: row.accountId, displayName: resolveAccountDisplayLabelV1(row.account) } });
            }
        }
        attached.sort((a, b) => a.triggerId.localeCompare(b.triggerId));
        const sourceTriggers = attached.filter(row => row.setUpBy.accountId !== params.accountId)
            .map(row => ({ automationId: row.automationId, triggerId: row.triggerId }));
        const actorReferences = await readAutomationActorConsentReferencesInTx(tx, { accountId: params.accountId, sourceTriggers });
        return { page: { attached, skippedNotSharedCount, nextCursor: page.length > limit ? selected.at(-1)!.id : null }, actorReferences };
    }, { transactionClass: 'automation-attached-trigger-list' });
    // The consent owner returns all historical actor references. This identity
    // join does not decide currentness, pending approval or the latest Run.
    const actorTriggers = new Map<string, Map<string, string[]>>();
    for (const row of actorReferences) {
        let sourceTriggers = actorTriggers.get(row.consentFor.automationId);
        if (!sourceTriggers) actorTriggers.set(row.consentFor.automationId, sourceTriggers = new Map());
        const triggers = sourceTriggers.get(row.consentFor.triggerId) ?? [];
        triggers.push(row.triggerId);
        sourceTriggers.set(row.consentFor.triggerId, triggers);
    }
    const actualTriggerIdsByTriggerId = new Map(page.attached.flatMap(row => {
        const actualIds = row.setUpBy.accountId === params.accountId ? [row.triggerId]
            : actorTriggers.get(row.automationId)?.get(row.triggerId);
        return actualIds ? [[row.triggerId, actualIds] as const] : [];
    }));
    const sourceArtifactIds = [...new Set(page.attached.flatMap(row => {
        const ref = parseWorkflowDefinitionRefV1(row.workflowDefinitionId);
        return ref?.kind === 'artifact' ? [ref.artifactId] : [];
    }))];
    const lastRuns = new Map<string, WorkflowRunLastStartedSummaryV1 | null>();
    let remaining = [...actualTriggerIdsByTriggerId.keys()];
    while (remaining.length > 0) {
        const summaries = await summarizeWorkflowRuns({ accountId: params.accountId, triggerIds: remaining,
            sourceArtifactIds, actualTriggerIdsByTriggerId, pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES });
        for (const summary of summaries.triggerSummaries) lastRuns.set(summary.triggerId, summary.lastRun);
        remaining = [...summaries.remainingTriggerIds];
    }
    const attached = page.attached.map(row => {
        return lastRuns.has(row.triggerId) ? { ...row, lastRun: lastRuns.get(row.triggerId)! } : row;
    });
    const bounded = appendBoundedPage({ existing: [], existingBytes: 2, candidates: attached,
        byteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        serializeMembers: row => [JSON.stringify(row)], nextCursorFor: row => row.triggerId,
        hasMoreAfter: index => index < attached.length - 1 || page.nextCursor !== null,
        emptyPage: nextCursor => ({ sets: [], attached: [], nextCursor: nextCursor ?? null,
            skippedNotSharedCount: page.skippedNotSharedCount }),
    });
    return { ...page, attached: bounded.rows,
        nextCursor: bounded.shortened ? bounded.rows.at(-1)!.triggerId : page.nextCursor };
}
