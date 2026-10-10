import * as React from 'react';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ActionId } from '@happier-dev/protocol';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, PersistedBackendTargetRefV2Schema, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ExecutionRunLaunchOrigin } from '@happier-dev/protocol/execution/runs/startRequest';
import { resolveReviewEngineTarget } from '@/sync/domains/reviews/reviewEngineCatalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { useResumeCapabilityOptions } from '@/agents/hooks/useResumeCapabilityOptions';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionViewShellSession } from '@/components/sessions/shell/sessionViewStableSession';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { useSettings } from '@/sync/domains/state/storage';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProfileCatalog } from '@/sync/store/useProfileCatalog';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { admitExecutionRunLaunchTarget, isExecutionRunSessionProfileReady } from './executionRunLaunchAdmission';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readAppliedModelSelection } from '@/sync/domains/models/describeEffectiveModelMode';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { t } from '@/text';

/** Exact Account, Session and Machine admission shared by every Run launcher presentation. */
export function useExecutionRunLaunchContext(sessionId: string | null, serverId: string | null,
    workspace?: Readonly<{ machineId: string; cwd: string }>) {
    const storedSession = useSessionViewShellSession(sessionId ?? '', serverId);
    const session = sessionId ? storedSession : null;
    const activeSettings = useSettings();
    const activeSettingsScope = useAccountSettingsScope();
    const requestedServerIds = React.useMemo(() => [serverId], [serverId]);
    const accountBindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const accountBinding = React.useMemo(() => [...accountBindings.values()][0] ?? null, [accountBindings]);
    const profileCatalog = useProfileCatalog(accountBinding?.scope);
    const profileCatalogReady = isExecutionRunSessionProfileReady(session, profileCatalog?.catalog);
    const { snapshot: acpCatalog } = useAcpCatalog(accountBinding?.scope ?? null);
    const acpCatalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const acpCatalogSnapshot = acpCatalogReady ? acpCatalog.catalog : undefined;
    const exactSettings = React.useMemo(() => {
        if (!accountBinding?.isCurrent()) return null;
        if (activeSettingsScope && areAccountSettingsScopesEqual(activeSettingsScope, accountBinding.scope)) return activeSettings;
        const persisted = loadAccountSettings(accountBinding.scope);
        return persisted.version === null ? null : settingsParse(persisted.settings);
    }, [accountBinding, activeSettings, activeSettingsScope]);
    const settings = exactSettings ?? settingsDefaults;
    const enabledAgentIds = React.useMemo(() => getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }), [settings.backendEnabledByTargetKey]);
    const defaultBackend = React.useMemo(() => session ? resolveSessionActionDefaultBackend({ session, enabledAgentIds,
        fallbackAgentId: resolveAgentIdFromSessionMetadata(session.metadata) ?? undefined }) : null, [enabledAgentIds, session]);
    const backendTarget = React.useMemo(() => resolveSessionActionDefaultTarget(defaultBackend), [defaultBackend]);
    const inheritedModelSelection = React.useMemo(() => session && backendTarget && defaultBackend?.defaultAgentId
        ? readAppliedModelSelection({ agentId: defaultBackend.defaultAgentId,
            agentTargetKey: buildBackendTargetKeyV2(backendTarget), metadata: readSessionOwnerMetadataView(session) })
        : null, [session, backendTarget, defaultBackend?.defaultAgentId]);
    const inheritedConnectedServicesSelection = React.useMemo(() => session && defaultBackend?.defaultAgentId
        ? readSessionConnectedServiceBindings({ agentId: defaultBackend.defaultAgentId, metadata: readSessionOwnerMetadataView(session) })
        : null, [session, defaultBackend?.defaultAgentId]);
    const inheritedRoutePresentation = React.useMemo(() => {
        const bindingsByServiceId = inheritedConnectedServicesSelection?.bindingsByServiceId ?? {};
        const auth = resolveConnectedServicesAuthLabel({ supportedServiceIds: Object.keys(bindingsByServiceId), bindingsByServiceId,
            profileOptionsByServiceId: {}, bindingPresentation: 'requested', resolveServiceTitle: (serviceId) => serviceId,
            nativeLabel: t('connectedServices.authChip.nativeLabel'),
            formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }) });
        const provider = session ? readSessionProviderBindingMetadataV1(readSessionOwnerMetadataView(session)) : null;
        return resolveSessionRoutePresentation({ phase: 'running', selection: null, appliedSelection: inheritedModelSelection,
            native: { label: auth.label, connectedCount: auth.connectedCount,
                authSource: inheritedConnectedServicesSelection === null ? 'unknown' : auth.connectedCount > 0 ? 'connected' : 'native' },
            ...(provider ? { appliedProviderSource: { connectionId: provider.connectionId, ...provider.displaySnapshot } } : {}) });
    }, [session, inheritedModelSelection, inheritedConnectedServicesSelection]);
    const sessionMachineTarget = useSessionMachineTarget(sessionId, serverId);
    const workspaceMachine = useMachinePresenceSummary(serverId, sessionId ? null : workspace?.machineId);
    const workspaceMachineKnown = workspaceMachine.reachability !== 'unknown';
    const machineTarget = React.useMemo(() => sessionId ? sessionMachineTarget
        : workspace && workspaceMachineKnown ? { machineId: workspace.machineId, basePath: workspace.cwd } : null,
        [sessionId, sessionMachineTarget, workspace?.machineId, workspace?.cwd, workspaceMachineKnown]);
    const machineId = machineTarget?.machineId ?? null;
    const { resumeCapabilityOptions } = useResumeCapabilityOptions({ agentId: defaultBackend?.defaultAgentId ?? null,
        machineId, serverId, accountScope: accountBinding?.scope ?? null, settings, enabled: session?.active === false });
    const sessionReachability = useSessionMachineReachability(sessionId ?? '', serverId);
    const machineReachable = sessionId ? sessionReachability.machineReachable : workspaceMachine.reachability === 'reachable';
    const accountLifetime = React.useMemo(() => {
        if (!accountBinding) return null;
        const scope = createServerAccountScope(accountBinding.serverId, accountBinding.accountId);
        return scope ? { scope, isCurrent: accountBinding.isCurrent, onRetire: accountBinding.onRetire } : null;
    }, [accountBinding]);
    const executor = React.useMemo(() => createDefaultActionExecutor({ resolveServerIdForSessionId: () => serverId }), [serverId]);
    const admitExactTarget = React.useCallback(async (requires: Readonly<{
        secretReferenceOverlay: boolean; teamCredentialModel: boolean; roleBinding?: boolean;
    }>, readinessOperationId: string, runBackendTargets?: readonly PersistedBackendTargetRefV2[]) => {
        await admitExecutionRunLaunchTarget({ sessionId, serverId, session, exactSettings, settings, accountLifetime,
            ...(workspace ? { cwd: workspace.cwd } : {}),
            machineId, ...(machineTarget ? { machineTarget } : {}), machineReachable, resumeCapabilityOptions,
            defaultBackend, runBackendTargets, requirements: requires, readinessOperationId });
    }, [session, exactSettings, accountLifetime, sessionId, serverId, machineId, machineTarget, machineReachable, resumeCapabilityOptions, defaultBackend, settings, workspace?.cwd]);
    const startAction = React.useCallback(async (actionId: ActionId, input: Record<string, unknown>, readinessOperationId: string,
        launchOrigin?: ExecutionRunLaunchOrigin) => {
        const rawTargets = actionId === 'execution.run.start' ? [input.backendTarget]
            : actionId === 'review.start' ? input.engineIds : input.backendTargetKeys;
        const runBackendTargets = Array.isArray(rawTargets) ? rawTargets.flatMap((value) => {
            if (actionId === 'execution.run.start') {
                const target = PersistedBackendTargetRefV2Schema.safeParse(value);
                return target.success ? [target.data] : [];
            }
            if (typeof value !== 'string') return [];
            try {
                return [actionId === 'review.start' ? resolveReviewEngineTarget(value) : readBackendTargetRefV2(value)];
            } catch {
                // Invalid Action input is refused by the existing Action schema.
                return [];
            }
        }) : [];
        await admitExactTarget({ secretReferenceOverlay: input.secretReferenceOverlay !== undefined,
            teamCredentialModel: input.teamCredentialModel !== undefined, roleBinding: input.roleId !== undefined }, readinessOperationId, runBackendTargets);
        return executor.execute(actionId, { ...input, sessionId,
            ...(!sessionId && workspace ? { target: { kind: 'detached' }, machineId: workspace.machineId, cwd: workspace.cwd } : {}) },
            { ...(sessionId ? { defaultSessionId: sessionId } : {}), ...(serverId ? { serverId } : {}),
                ...(machineId ? { executionRunTargetMachineId: machineId } : {}),
                ...(launchOrigin ? { executionRunLaunchOrigin: launchOrigin } : {}),
                ...(!sessionId && workspace ? { externalActionTarget: { kind: 'machine' as const, machineId: workspace.machineId } } : {}) });
    }, [admitExactTarget, executor, machineId, sessionId, serverId, workspace?.machineId, workspace?.cwd]);
    return { session, accountBinding, accountLifetime, exactSettings, settings, profileCatalogReady, acpCatalogReady, acpCatalogSnapshot, enabledAgentIds, defaultBackend,
        backendTarget, inheritedModelSelection, inheritedConnectedServicesSelection, inheritedRoutePresentation, machineTarget, machineId, admitExactTarget, startAction };
}
