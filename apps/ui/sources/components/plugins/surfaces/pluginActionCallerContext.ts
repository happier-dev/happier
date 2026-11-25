import type { ActionPluginCaller } from '@happier-dev/protocol/actions/executor/types';

export const PLUGIN_ACTION_CALLER_AUTHORITY = 'account_automation' as const;

/** The host stamps Plugin provenance without lending the person's authority. */
export function createPluginActionCallerContext(caller?: Omit<ActionPluginCaller, 'kind'>) {
    return {
        authority: PLUGIN_ACTION_CALLER_AUTHORITY,
        ...(caller ? { actionCaller: { ...caller, kind: 'plugin' as const } } : {}),
    };
}
