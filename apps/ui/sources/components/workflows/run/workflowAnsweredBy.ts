import type { WorkflowReviewResultSourceV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t } from '@/text';
import { useWorkflowSourcePeople } from '../useWorkflowSourcePeople';

/**
 * Who answered a Wait or review, in one quiet line beside the completed answer.
 *
 * Only a human-accepted result names a person. The name comes from the Account display-name owner and
 * from the shared, authorized People projection. An unavailable Account stays anonymous rather
 * than being guessed from the Run's starter or a Team grant.
 */
export function resolveAnsweredByLabel(input: Readonly<{
    resultSource: WorkflowReviewResultSourceV1 | undefined;
    viewerAccountId: string | null;
    profile: Readonly<{ name?: string | null; username?: string | null }> | null | undefined;
}>): string | null {
    const source = input.resultSource;
    if (source?.kind !== 'human') return null;
    if (source.accountId === input.viewerAccountId) return t('workflows.run.answeredByYou');
    const name = input.profile ? formatAccountDisplayName(input.profile) : null;
    return name ? t('workflows.run.answeredBy', { name }) : t('workflows.run.answeredByPerson');
}

export function useAnsweredByLabel(resultSource: WorkflowReviewResultSourceV1 | undefined): string | null {
    const accountId = resultSource?.kind === 'human' ? resultSource.accountId : undefined;
    const people = useWorkflowSourcePeople(accountId ? [{ kind: 'person', accountId }] : []);
    const viewerAccountId = people.viewerAccountId;
    const profile = people.profiles.get(accountId ?? '')?.profile;
    if (accountId && accountId !== viewerAccountId && people.status === 'loading') return null;
    return resolveAnsweredByLabel({ resultSource, viewerAccountId, profile });
}
