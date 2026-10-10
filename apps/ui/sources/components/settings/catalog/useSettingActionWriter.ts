import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { SettingRef, SettingValue } from './settingDeclarations';

/** Exact declared-setting ingress; the mounted Action owner retains admission and approval. */
export function useSettingActionWriter(options: Readonly<{ serverId?: string }> = {}) {
    const scope = useAccountSettingsScope();
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [scope]);
    const mounted = useMountedActionExecution(scope);
    const serverId = options.serverId;
    return React.useCallback(async (setting: Pick<SettingRef, 'anchor'>, value: SettingValue,
        operation?: Readonly<{ signal?: AbortSignal }>): Promise<ActionExecuteResult> => {
        if (!scope || !lifetime?.isCurrent()
            || !areAccountSettingsScopesEqual(scope, lifetime.scope)
            || !areAccountSettingsScopesEqual(scope, getStorage().getState().settingsScope)
            || serverId !== undefined && !selectActiveServerAccountScopeForServer(scope, serverId)) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const cancellation = mergeAbortSignals([controller.signal, operation?.signal]);
        try {
            return await mounted.execute('settings.set', { anchor: setting.anchor, value }, { signal: cancellation.signal });
        } finally {
            cancellation.dispose();
            retirement.dispose();
        }
    }, [lifetime, mounted.execute, scope, serverId]);
}
