import * as React from 'react';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ActionId } from '@happier-dev/protocol';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { useSettings } from '@/sync/domains/state/storage';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { admitExecutionRunLaunchTarget } from './executionRunLaunchAdmission';

/** Exact Account, Session and Machine admission shared by every Run launcher presentation. */
export function useExecutionRunLaunchContext(sessionId: string, serverId: string | null) {
    const session = useSessionViewShellSession(sessionId, serverId);
    const activeSettings = useSettings();
    const activeSettingsScope = useAccountSettingsScope();
    const requestedServerIds = React.useMemo(() => [serverId], [serverId]);
    const accountBindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const accountBinding = React.useMemo(() => [...accountBindings.values()][0] ?? null, [accountBindings]);
    const exactSettings = React.useMemo(() => {
        if (!accountBinding?.isCurrent()) return null;
        if (activeSettingsScope && areAccountSettingsScopesEqual(activeSettingsScope, accountBinding.scope)) return activeSettings;
        const persisted = loadAccountSettings(accountBinding.scope);
        return persisted.version === null ? null : settingsParse(persisted.settings);
    }, [accountBinding, activeSettings, activeSettingsScope]);
    const settings = exactSettings ?? settingsDefaults;
    const enabledAgentIds = React.useMemo(() => getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }), [settings.backendEnabledByTargetKey]);
    const defaultBackend = React.useMemo(() => resolveSessionActionDefaultBackend({ session, enabledAgentIds,
        fallbackAgentId: resolveAgentIdFromSessionMetadata(session?.metadata) ?? undefined }), [enabledAgentIds, session]);
    const backendTarget = React.useMemo(() => resolveSessionActionDefaultTarget(defaultBackend), [defaultBackend]);
    const machineTarget = useSessionMachineTarget(sessionId, serverId);
    const machineId = machineTarget?.machineId ?? null;
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({ agentId: defaultBackend?.defaultAgentId ?? null,
        machineId, serverId, settings, enabled: session?.active === false });
    const { machineReachable } = useSessionMachineReachability(sessionId, serverId);
    const accountLifetime = React.useMemo(() => {
        if (!accountBinding) return null;
        const scope = createServerAccountScope(accountBinding.serverId, accountBinding.accountId);
        return scope ? { scope, isCurrent: accountBinding.isCurrent, onRetire: accountBinding.onRetire } : null;
    }, [accountBinding]);
    const executor = React.useMemo(() => createDefaultActionExecutor({ resolveServerIdForSessionId: () => serverId }), [serverId]);
    const admitExactTarget = React.useCallback(async (requires: Readonly<{
        secretReferenceOverlay: boolean; teamCredentialModel: boolean; roleBinding?: boolean;
    }>, readinessOperationId: string) => {
        await admitExecutionRunLaunchTarget({ sessionId, serverId, session, exactSettings, settings, accountLifetime,
            machineId, ...(machineTarget ? { machineTarget } : {}), machineReachable, resumeCapabilityOptions,
            defaultBackend, requirements: requires, readinessOperationId });
    }, [session, exactSettings, accountLifetime, sessionId, serverId, machineId, machineTarget, machineReachable, resumeCapabilityOptions, defaultBackend, settings]);
    const startAction = React.useCallback(async (actionId: ActionId, input: Record<string, unknown>, readinessOperationId: string) => {
        await admitExactTarget({ secretReferenceOverlay: input.secretReferenceOverlay !== undefined,
            teamCredentialModel: input.teamCredentialModel !== undefined, roleBinding: input.roleId !== undefined }, readinessOperationId);
        return executor.execute(actionId, { ...input, sessionId }, { defaultSessionId: sessionId, ...(serverId ? { serverId } : {}) });
    }, [admitExactTarget, executor, sessionId, serverId]);
    return { session, accountBinding, accountLifetime, exactSettings, settings, enabledAgentIds, defaultBackend,
        backendTarget, machineTarget, machineId, admitExactTarget, startAction };
}
