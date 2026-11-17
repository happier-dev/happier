import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getApprovalProfileCatalogRows } from '@/sync/engine/settings/approvalProfileCatalog';

import { ACCOUNT_ACTION_SETTINGS_TARGET, resolveActionSettingsTargetWrite,
    type ActionSettingsTarget, type ActionSettingsTargetWrite } from './actionSettingsTarget';

/**
 * Submit one policy intent for the screen's target; mounted Action admission owns the Account and approval lifetime.
 * A profile target turns the intent into its held Artifact row and revision current at the press.
 */
export function useActionPolicyWriter(
    target: ActionSettingsTarget = ACCOUNT_ACTION_SETTINGS_TARGET,
): (input: ActionSettingsTargetWrite) => Promise<ActionExecuteResult> {
    const scope = getStorage()(state => state.settingsScope);
    const { execute } = useMountedActionExecution(scope);
    const profileId = target.kind === 'profile' ? target.id : null;
    return React.useCallback((input: ActionSettingsTargetWrite) => {
        if ('ok' in input) return Promise.resolve(input);
        if (profileId === null) return execute('actions.policy.set', input);
        const account = normalizeActionsSettingsV1(getStorage().getState().settings.actionsSettingsV1);
        const write = resolveActionSettingsTargetWrite({ target: { kind: 'profile', id: profileId }, account,
            profileRows: getApprovalProfileCatalogRows(scope), input });
        // The profile screens offer only what a profile carries, so an unsupported intent is a screen defect.
        if (!write) throw new Error('approval_profile_unsupported_change');
        if ('ok' in write) return Promise.resolve(write);
        return execute('actions.policy.set', write);
    }, [execute, profileId, scope]);
}
