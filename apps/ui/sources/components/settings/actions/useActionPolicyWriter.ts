import * as React from 'react';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';

import { ACCOUNT_ACTION_SETTINGS_TARGET, resolveActionSettingsTargetWrite, type ActionSettingsTarget } from './actionSettingsTarget';

/**
 * Submit one policy intent for the screen's target; mounted Action admission owns the Account and approval lifetime.
 * A profile target turns the intent into that profile's row from the Account settings current at the press.
 */
export function useActionPolicyWriter(
    target: ActionSettingsTarget = ACCOUNT_ACTION_SETTINGS_TARGET,
): (input: ActionPolicySetInput) => Promise<ActionExecuteResult> {
    const scope = getStorage()(state => state.settingsScope);
    const { execute } = useMountedActionExecution(scope);
    const profileId = target.kind === 'profile' ? target.id : null;
    return React.useCallback((input: ActionPolicySetInput) => {
        if (profileId === null) return execute('actions.policy.set', input);
        const account = normalizeActionsSettingsV1(getStorage().getState().settings.actionsSettingsV1);
        const write = resolveActionSettingsTargetWrite({ target: { kind: 'profile', id: profileId }, account, input });
        // The profile screens offer only what a profile carries, so a refused intent is a screen defect.
        if (!write) throw new Error('approval_profile_unsupported_change');
        return execute('actions.policy.set', write);
    }, [execute, profileId]);
}
