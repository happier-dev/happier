import * as React from 'react';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createScopedPluginSettingsActionAdapter } from '@/sync/domains/plugins/settings/scopedPluginSettingsActionAdapter';
import type { ScopedPluginSettingsAdapter, ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/** Settings retain their existing Action invocation and declaration guard while approval is pending. */
export function useMountedPluginSettingsActionAdapter(params: Readonly<{
    adapter: ScopedPluginSettingsAdapter;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    target: ScopedPluginSettingsTarget | null;
}>): ScopedPluginSettingsAdapter {
    const scope = params.target?.kind === 'daemon' ? params.target.serverId : params.accountLifetime?.scope;
    const { execute } = useMountedActionExecution(scope, { retainInvocation: true });
    return React.useMemo(() => createScopedPluginSettingsActionAdapter({
        adapter: params.adapter,
        accountLifetime: params.accountLifetime,
        execute: (id, input, context) => execute(id, input, {
            signal: context?.signal,
            isPluginSettingsIntentCurrent: context?.isPluginSettingsIntentCurrent,
        }),
    }), [execute, params.accountLifetime, params.adapter]);
}
