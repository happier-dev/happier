import type { WorkflowDefinitionSavedByV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';

export { readWorkflowRunSourceSavedByV1 as readFrozenSavedBy } from '@happier-dev/protocol/workflows/workflowRunDisplayMetadataV1';

/**
 * Presentation only: a frozen occurrence or a current definition supplies the fact.
 *
 * The viewer's own save reads "Edited by you" only in Workflow History (`viewerOwnSave: 'you'`), where
 * occurrences are compared with each other; every other Run or trigger row omits it (`'omit'`), so a
 * person's own workflows stay quiet. Other people and agents are always named.
 */
export function resolveEditedByLabel(input: Readonly<{
    savedBy: WorkflowDefinitionSavedByV1 | null | undefined;
    viewerAccountId: string | null | undefined;
    profile?: Readonly<{ name?: string | null; username?: string | null }> | null;
    viewerOwnSave: 'you' | 'omit';
}>): string | null {
    if (!input.savedBy) return null;
    if (input.savedBy.kind === 'agent') return t('workflows.run.editedByAgent');
    if (input.savedBy.accountId === input.viewerAccountId) {
        return input.viewerOwnSave === 'you' ? t('workflows.run.editedByYou') : null;
    }
    const name = input.profile ? formatAccountDisplayName(input.profile) : null;
    return name ? t('workflows.run.editedBy', { name }) : t('workflows.run.editedByPerson');
}
