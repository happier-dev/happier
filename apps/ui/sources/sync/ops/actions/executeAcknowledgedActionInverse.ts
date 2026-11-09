import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveAcknowledgedActionInverse, type AcknowledgedActionResult } from '@/components/approvals/actionResultFacts';
import { fetchSessionOrganizationSnapshot } from '@/sync/api/session/sessionOrganizationApi';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureLazyActionAccountContext } from './actionAccountContext';
import type { UiActionOperation } from './frontDoorRuntimeActionExecutor';
import { scopedHomeActionExecutor } from './scopedHomeActionExecutor';

/** A result card lends its original scope; the currently viewed Home is never a fallback. */
export async function executeAcknowledgedActionInverse(
    fact: AcknowledgedActionResult,
    scope: ServerAccountScope,
    operation?: UiActionOperation,
): Promise<ActionExecuteResult> {
    if (!fact.inverse) return { ok: false, errorCode: 'action_inverse_unavailable', error: 'No inverse is available for this Action result' };
    const account = await captureLazyActionAccountContext(scope.serverId, operation?.signal);
    try {
        account.assertCurrent();
        if (account.accountId !== scope.accountId) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'The original Account is no longer selected' };
        }
        let snapshotReceived = false;
        const response = await fetchSessionOrganizationSnapshot({
            credentials: account.credentials, requestAtEndpoint: account.request,
            request: { includeFolders: false, includeTags: false, includeLabels: false,
                assignmentSessionIds: [fact.sessionId], includeAllFolderAssignments: false },
            onSnapshotReceived: () => { snapshotReceived = true; },
        });
        account.assertCurrent();
        if (!snapshotReceived) return { ok: false, errorCode: 'section_membership_unavailable', error: 'Current Section membership is unavailable' };
        const currentSectionId = response.snapshot.folderAssignments.find(row => row.sessionId === fact.sessionId)?.folderId ?? null;
        const inverse = resolveAcknowledgedActionInverse(fact, currentSectionId);
        if (!inverse) return { ok: false, errorCode: 'section_membership_changed', error: 'The Session has moved since this result' };
        return await scopedHomeActionExecutor(scope)(inverse.actionId, inverse.input, {
            ...operation, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
        });
    } finally {
        account.dispose();
    }
}
