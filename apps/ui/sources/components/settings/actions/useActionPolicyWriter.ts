import * as React from 'react';
import type { ActionPolicySetInput } from '@happier-dev/protocol/actions/actionPolicyActionFamily';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';

/** Submit one policy intent; mounted Action admission owns the Account and approval lifetime. */
export function useActionPolicyWriter(): (input: ActionPolicySetInput) => Promise<ActionExecuteResult> {
    const scope = getStorage()(state => state.settingsScope);
    const { execute } = useMountedActionExecution(scope);
    return React.useCallback((input: ActionPolicySetInput) => execute('actions.policy.set', input), [execute]);
}
