import { parseAutomationStoredWorkflowDefinitionRecipeV2, AutomationStoredWorkflowDefinitionV2ReadSchema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { summarizeWorkflowTriggerRowsV1, type WorkflowTriggerSummaryV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { resolveWorkflowRunAdmissionRecipientAccountIdsInTx, resolveWorkflowRunVisibilityScopesInTx } from '@/app/workflows/workflowRunAccess';
import { inTx, type Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { automationDefinitionListItemSelect } from './automationPersistenceSelect';
import { toAutomationDefinitionListItemApiDto } from './automationApiProjection';
import { loadAutomationEventStatusProjections } from './automationEventStatusProjection';
import { loadAutomationSessionLifecycleStatusProjections } from './automationSessionLifecycleStatusProjection';
import type { AutomationListItem } from './automationTypes';

function readSelectedTeam(row: Readonly<{ templateCiphertext: string; account: { encryptionMode: unknown } }>): string | null {
    const parsed = parseAutomationStoredWorkflowDefinitionRecipeV2(row.templateCiphertext);
    if (parsed.kind !== 'available') return null;
    const recipe = parsed.recipe;
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    if (mode.status !== 'ready' || (mode.mode === 'plain' ? recipe.workflow.t !== 'plain' : recipe.workflow.t !== 'encrypted')) return null;
    // Retained plain recipes carry this fact in the explicit plain arm. Encrypted
    // predecessors without public audience metadata remain private until re-saved.
    return (recipe.workflow.t === 'plain'
        ? AutomationStoredWorkflowDefinitionV2ReadSchema.parse(recipe.workflow.v).visibleTeamId
        : recipe.visibleTeamId) ?? null;
}

export type SharedWorkflowSummaryDefinition = Readonly<{
    accountId: string; workflowDefinitionId: string | null; scopeSessionId: string | null;
    templateCiphertext: string; account: { encryptionMode: unknown };
}>;

/** Publication admission and invalidation consume the same selected audience. */
export async function readSharedWorkflowTriggerSummaryRecipientsInTx(tx: Tx, row: SharedWorkflowSummaryDefinition): Promise<string[]> {
    if (row.scopeSessionId !== null || row.workflowDefinitionId === null) return [];
    const visibleTeamId = readSelectedTeam(row);
    if (visibleTeamId === null) return [];
    return resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
        accountId: row.accountId, sourceArtifactId: row.workflowDefinitionId, visibleTeamId,
    });
}

/** Reuse Artifact invalidation so every mounted library consumer refreshes without private Automation events. */
export async function markSharedWorkflowTriggerSummaryChangedInTx(tx: Tx, automationId: string): Promise<void> {
    const row = await tx.automation.findUnique({ where: { id: automationId }, select: {
        accountId: true, workflowDefinitionId: true, scopeSessionId: true, templateCiphertext: true,
        account: { select: { encryptionMode: true } },
    } });
    if (!row || row.workflowDefinitionId === null) return;
    const recipients = await readSharedWorkflowTriggerSummaryRecipientsInTx(tx, row);
    await markAccountsChanged(tx, { accountIds: recipients.filter(id => id !== row.accountId),
        kind: 'artifact', entityId: row.workflowDefinitionId });
}

/** Team schedule facts share the Run audience owner; private trigger details stay Account-only. */
export async function readSharedWorkflowTriggerSummaries(input: Readonly<{
    accountId: string; workflowDefinitionIds: readonly string[];
}>): Promise<WorkflowTriggerSummaryV1[]> {
    if (input.workflowDefinitionIds.length === 0) return [];
    const rows = await inTx(async tx => {
        const scopes = await resolveWorkflowRunVisibilityScopesInTx(tx, {
            actorAccountId: input.accountId, sourceArtifactIds: input.workflowDefinitionIds,
        });
        if (scopes.length === 0) return [];
        const teamsBySource = new Map(scopes.map(scope => [scope.sourceArtifactId, scope.visibleTeamIds]));
        const candidates = await tx.automation.findMany({ where: { accountId: { not: input.accountId }, deletedAt: null,
            scopeSessionId: null, workflowDefinitionId: { in: [...teamsBySource.keys()] } },
            select: { ...automationDefinitionListItemSelect, templateCiphertext: true, account: { select: { encryptionMode: true } } } });
        // Match the canonical definition readers: stored trigger rows use the
        // current Automation domain, while Prisma retains legacy enum members.
        return candidates.filter(row => {
            const visibleTeamId = readSelectedTeam(row);
            return visibleTeamId !== null && row.workflowDefinitionId !== null
                && teamsBySource.get(row.workflowDefinitionId)?.includes(visibleTeamId) === true;
        }) as AutomationListItem[];
    });
    const [events, lifecycle] = await Promise.all([
        loadAutomationEventStatusProjections({ automations: rows }),
        loadAutomationSessionLifecycleStatusProjections({ automations: rows }),
    ]);
    return [...summarizeWorkflowTriggerRowsV1(rows.map(row => toAutomationDefinitionListItemApiDto(row, events, lifecycle.get(row.id)))).values()];
}
