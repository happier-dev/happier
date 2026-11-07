import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { SettingsDeclarationTargetV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { readBuiltInSettingDeclarationV1 } from '@happier-dev/protocol/actions/settings/settingsDeclarations';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import type { SettingRef, SettingValue } from './settingDeclarations';

export type SettingActionAddress = Pick<SettingRef, 'anchor'> & Readonly<{ key?: string; target?: SettingsDeclarationTargetV1 }>;

/** Exact declared-setting ingress; the mounted Action owner retains admission and approval. */
export function useSettingActionWriter(options: Readonly<{ serverId?: string; beforeLocalCommit?: () => void;
    executorOptions?: NonNullable<Parameters<typeof useMountedActionExecution>[1]>['executorOptions'];
}> = {}) {
    const scope = getStorage()(state => state.settingsScope);
    // The same Account can become available after this control mounts, or reconnect after
    // retiring its previous runtime. Scope identity alone does not identify that lifetime.
    const lifetime = useActiveServerAccountScopeLifetime();
    const beforeLocalCommit = options.beforeLocalCommit;
    const suppliedExecutorOptions = options.executorOptions;
    const executorOptions = React.useMemo(() => ({ ...suppliedExecutorOptions, beforeLocalSettingCommit: beforeLocalCommit }), [beforeLocalCommit, suppliedExecutorOptions]);
    // A setting control has no inline decision surface: an Ask-first wait opens the existing Inbox review.
    const mounted = useMountedActionExecution(scope, { executorOptions });
    const localFrontDoor = React.useMemo(() => createFrontDoorActionExecute(undefined, executorOptions), [executorOptions]);
    const localLifetime = React.useMemo(() => ({ controller: new AbortController() }), [scope]);
    React.useEffect(() => {
        if (localLifetime.controller.signal.aborted) localLifetime.controller = new AbortController();
        const controller = localLifetime.controller;
        return () => controller.abort();
    }, [localLifetime]);
    const serverId = options.serverId;
    const isAccountCurrent = React.useCallback((setting?: SettingActionAddress) => {
        if (!scope && !lifetime && serverId === undefined && !getActiveServerAccountScope()
            && setting
            && readBuiltInSettingDeclarationV1(setting.anchor)?.storage?.scope === 'local') return true;
        return Boolean(scope && lifetime?.isCurrent()
        && areAccountSettingsScopesEqual(scope, lifetime.scope)
        && areAccountSettingsScopesEqual(scope, getStorage().getState().settingsScope)
        && (serverId === undefined || selectActiveServerAccountScopeForServer(scope, serverId)));
    }, [lifetime, scope, serverId]);
    const isCurrent = React.useCallback((setting?: SettingActionAddress) => isAccountCurrent(setting)
        && (!lifetime ? !localLifetime.controller.signal.aborted : mounted.isCurrent()),
    [isAccountCurrent, lifetime, localLifetime, mounted.isCurrent]);
    const write = React.useCallback(async (setting: SettingActionAddress, value: SettingValue,
        operation?: Readonly<{ signal?: AbortSignal; expectedSettingsVersion?: number;
            invocation?: CurrentUiContextCommandInvocation;
            onApprovalPending?: () => void;
            executorOptions?: NonNullable<Parameters<typeof useMountedActionExecution>[1]>['executorOptions'];
        }>): Promise<ActionExecuteResult> => {
        const revision = operation?.expectedSettingsVersion === undefined ? {}
            : { expectedSettingsVersion: operation.expectedSettingsVersion };
        // Device preferences remain available before sign-in, through the same executor policy.
        if (!lifetime && isCurrent(setting) && !operation?.invocation) {
            return await localFrontDoor('settings.set', { anchor: setting.anchor,
                ...revision,
                ...(setting.key !== undefined ? { key: setting.key } : {}),
                ...(setting.target ? { target: setting.target } : {}), value }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                signal: operation?.signal,
            });
        }
        if (!lifetime || !isCurrent()) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const input = { anchor: setting.anchor, ...revision, ...(setting.key !== undefined ? { key: setting.key } : {}),
            ...(setting.target ? { target: setting.target } : {}), value };
        const mountedOperation = {
            signal: operation?.signal,
            onApprovalPending: operation?.onApprovalPending,
            ...(operation?.executorOptions ? { executorOptions: operation.executorOptions } : {}),
            ...(setting.target?.kind === 'public_profile_draft' || readBuiltInSettingDeclarationV1(setting.anchor)?.storage?.scope === 'local'
                ? { retainInvocation: true as const } : {}),
        };
        return await (operation?.invocation
            ? operation.invocation.execute(mounted, 'settings.set', input, mountedOperation)
            : mounted.execute('settings.set', input, mountedOperation));
    }, [isCurrent, lifetime, localFrontDoor, mounted.execute, mounted.executeForCaller, mounted.binding]);
    return React.useMemo(() => Object.assign(write, { isCurrent, isAccountCurrent,
        ready: mounted.ready, approval: mounted.approval }), [isCurrent, isAccountCurrent, write, mounted.ready, mounted.approval]);
}
