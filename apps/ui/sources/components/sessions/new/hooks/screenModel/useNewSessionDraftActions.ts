import * as React from 'react';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import type { NewSessionDraftModelIntent } from '@happier-dev/protocol/actions/appShellActionFamily';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SessionDirectoryIntentV1 } from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';

/** UI edits enter the same admission and exact mounted-draft owner as agents. */
export function useNewSessionDraftActions(ref: ComposerRefV1, scope: ServerAccountScope | null) {
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const context = React.useMemo(() => ({ surface: 'ui' as const, authority: 'present_user' as const,
        ...(scope ? { serverId: scope.serverId, expectedAccountId: scope.accountId } : {}) }), [scope?.serverId, scope?.accountId]);
    const presentResult = React.useCallback((result: Awaited<ReturnType<typeof executor.execute>>) => {
        if (!result.ok) {
            if (!isActionApprovalDeclinedErrorCode(result.errorCode)) Modal.alert(t('common.error'), result.error);
            return false;
        }
        return result.result !== null && typeof result.result === 'object'
            && 'status' in result.result && result.result.status === 'applied';
    }, []);
    const setModel = React.useCallback(async (model: NewSessionDraftModelIntent) =>
        presentResult(await executor.execute('session.draft.model.set', { ref, model }, context)), [context, executor, presentResult, ref]);
    const setDirectory = React.useCallback(async (directory: SessionDirectoryIntentV1) =>
        presentResult(await executor.execute('session.draft.directory.set', { ref, directory }, context)), [context, executor, presentResult, ref]);
    return { setModel, setDirectory };
}
