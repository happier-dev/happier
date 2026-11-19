import * as React from 'react';
import { readReviewLauncherReviewers, readReviewLauncherEngineIds } from './reviewLauncherSelection';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
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
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTarget } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { storage } from '@/sync/domains/state/storage';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { loadAccountSettings } from '@/sync/domains/state/accountSettingsPersistence';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProfileCatalog } from '@/sync/store/useProfileCatalog';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { admitExecutionRunLaunchTarget, isExecutionRunSessionProfileReady } from './executionRunLaunchAdmission';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readAppliedModelSelection } from '@/sync/domains/models/describeEffectiveModelMode';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import { resolveSessionModelLabel } from '@/sync/domains/models/modelOptions';
import type { ProviderBoundModelRef } from '@happier-dev/protocol/providers/model-selection';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { readSessionProviderBindingMetadataV1 } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { resolveSessionRoutePresentation } from '@/providers/session/resolveSessionRoutePresentation';
import { useExecutionRunSourceLabel } from '@/components/sessions/runs/useExecutionRunSourceLabel';
import { projectExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import { resolveConnectedServicesAuthLabel } from '@/components/settings/connectedServices/model/resolveConnectedServicesAuthLabel';
import { t } from '@/text';

/** Exact Account, Session and Machine admission shared by every Run launcher presentation. */
export function useExecutionRunLaunchContext(sessionId: string | null, serverId: string | null,
    workspace?: Readonly<{ machineId: string; cwd: string }>) {
    const storedSession = useSessionViewShellSession(sessionId ?? '', serverId);
    const session = sessionId ? storedSession : null;
    const activeSettings = useSettingsValues(['backendEnabledByTargetKey', 'secrets', 'executionRunsNotifyParentOnCompletionDefault']);
    const activeSettingsScope = useAccountSettingsScope();
    const requestedServerIds = React.useMemo(() => [serverId], [serverId]);
    const accountBindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const accountBinding = React.useMemo(() => [...accountBindings.values()][0] ?? null, [accountBindings]);
    const profileCatalog = useProfileCatalog(accountBinding?.scope);
    const profileCatalogReady = isExecutionRunSessionProfileReady(session, profileCatalog?.catalog);
    const { snapshot: acpCatalog } = useAcpCatalog(accountBinding?.scope ?? null);
    const acpCatalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const acpCatalogSnapshot = acpCatalogReady ? acpCatalog.catalog : undefined;
    const readExactSettings = React.useCallback(() => {
        if (!accountBinding?.isCurrent()) return null;
        const current = storage.getState();
        if (current.settingsScope && areAccountSettingsScopesEqual(current.settingsScope, accountBinding.scope)) return current.settings;
        const persisted = loadAccountSettings(accountBinding.scope);
        return persisted.version === null ? null : settingsParse(persisted.settings);
    }, [accountBinding]);
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
    const inheritedAppliedSelection = React.useMemo(() => {
        if (!session || !backendTarget || !defaultBackend?.defaultAgentId) return null;
        const metadata = readSessionOwnerMetadataView(session);
        const target = { agentId: defaultBackend.defaultAgentId, agentTargetKey: buildBackendTargetKeyV2(backendTarget), metadata };
        // This is retained applied presentation, not current-runner authority. The host still admits
        // inheritance. Use the same strict Protocol fact as the Session chip and runtime publisher.
        const disposition = resolveSessionModelSelectionDisposition({ ...target,
            sessionActive: session.active === true, currentRunnerProcessIdentity: null });
        if (metadata?.sessionModelsV1?.activeSelectionV1 !== undefined) return {
            model: disposition.lastAppliedSelection, route: disposition.lastAppliedRouteSelection,
        };
        // Retained 0.2 metadata can carry only its legacy applied model; it cannot assert a Team source.
        const model = readAppliedModelSelection(target);
        return { model, route: model };
    }, [session, backendTarget, defaultBackend?.defaultAgentId]);
    const inheritedModelSelection = inheritedAppliedSelection?.model ?? null;
    const inheritedRouteSelection = inheritedAppliedSelection?.route ?? null;
    const inheritedTeamCredentialModel = React.useMemo<TeamCredentialProviderModelSelectionV1 | null>(() =>
        inheritedRouteSelection && 'source' in inheritedRouteSelection && inheritedRouteSelection.source === 'team_resource'
            ? { kind: 'team_credential_provider_model', teamId: inheritedRouteSelection.teamId,
                resourceId: inheritedRouteSelection.resourceId, expectedResourceRevision: inheritedRouteSelection.expectedResourceRevision,
                deliveryMode: inheritedRouteSelection.deliveryMode, agentTargetKey: inheritedRouteSelection.agentTargetKey,
                modelId: inheritedRouteSelection.modelId }
        : null, [inheritedRouteSelection]);
    /** The parent's catalog title for one of its native models; a Provider model's id is already its name. */
    const resolveInheritedModelLabel = React.useCallback((selection: ProviderBoundModelRef | null) =>
        session && defaultBackend?.defaultAgentId && selection && selection.providerConnectionId === null && !inheritedTeamCredentialModel
            ? resolveSessionModelLabel(defaultBackend.defaultAgentId, readSessionOwnerMetadataView(session), selection.modelId)
            : null, [session, defaultBackend?.defaultAgentId, inheritedTeamCredentialModel]);
    const inheritedConnectedServicesSelection = React.useMemo(() => session && defaultBackend?.defaultAgentId
        ? readSessionConnectedServiceBindings({ agentId: defaultBackend.defaultAgentId, metadata: readSessionOwnerMetadataView(session) })
        : null, [session, defaultBackend?.defaultAgentId]);
    const inheritedDisplaySelection = React.useMemo(() => projectExecutionRunResolvedSelection({ source: 'inherited',
        ...(inheritedTeamCredentialModel ? { teamCredentialModel: inheritedTeamCredentialModel }
            : inheritedModelSelection ? { modelSelection: inheritedModelSelection } : {}),
        connectedServices: inheritedConnectedServicesSelection,
    }), [inheritedModelSelection, inheritedTeamCredentialModel, inheritedConnectedServicesSelection]);
    const inheritedSourceLabel = useExecutionRunSourceLabel(inheritedDisplaySelection, serverId);
    const inheritedRoutePresentation = React.useMemo(() => {
        const bindingsByServiceId = inheritedConnectedServicesSelection?.bindingsByServiceId ?? {};
        const auth = resolveConnectedServicesAuthLabel({ supportedServiceIds: Object.keys(bindingsByServiceId), bindingsByServiceId,
            profileOptionsByServiceId: {}, bindingPresentation: 'requested', resolveServiceTitle: () => t('connectedServices.fallbackName'),
            nativeLabel: t('connectedServices.authChip.nativeLabel'),
            formatConnectedCountLabel: (count) => t('connectedServices.authChip.connectedCountLabel', { count }) });
        const provider = session ? readSessionProviderBindingMetadataV1(readSessionOwnerMetadataView(session)) : null;
        return resolveSessionRoutePresentation({ phase: 'running', selection: null, appliedSelection: inheritedRouteSelection,
            native: { label: inheritedSourceLabel ?? (auth.connectedCount > 0 ? t('common.unavailable') : auth.label), connectedCount: auth.connectedCount,
                authSource: inheritedConnectedServicesSelection === null ? 'unknown' : auth.connectedCount > 0 ? 'connected' : 'native' },
            ...(inheritedTeamCredentialModel && inheritedSourceLabel ? { teamSources: [{
                teamId: inheritedTeamCredentialModel.teamId, resourceId: inheritedTeamCredentialModel.resourceId,
                displayName: inheritedSourceLabel,
            }] } : {}),
            ...(provider ? { appliedProviderSource: { connectionId: provider.connectionId, ...provider.displaySnapshot } } : {}) });
    }, [session, inheritedRouteSelection, inheritedTeamCredentialModel, inheritedConnectedServicesSelection, inheritedSourceLabel]);
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
    const accountLifetime = accountBinding;
    const executorOptions = React.useMemo(() => ({ resolveServerIdForSessionId: () => serverId }), [serverId]);
    const executor = useMountedActionExecution(accountBinding?.scope, { executorOptions });
    const admitExactTarget = React.useCallback(async (requires: Readonly<{
        secretReferenceOverlay: boolean; teamCredentialModel: boolean; roleBinding?: boolean;
    }>, readinessOperationId: string, runBackendTargets?: readonly PersistedBackendTargetRefV2[]) => {
        const currentSettings = readExactSettings();
        await admitExecutionRunLaunchTarget({ sessionId, serverId, session, exactSettings: currentSettings, settings: currentSettings ?? settingsDefaults, accountLifetime,
            signal: executor.getSignal(),
            ...(workspace ? { cwd: workspace.cwd } : {}),
            machineId, ...(machineTarget ? { machineTarget } : {}), machineReachable, resumeCapabilityOptions,
            defaultBackend, runBackendTargets, requirements: requires, readinessOperationId });
    }, [session, readExactSettings, accountLifetime, sessionId, serverId, machineId, machineTarget, machineReachable, resumeCapabilityOptions, defaultBackend, workspace?.cwd, executor.getSignal]);
    // The start and unsaved authoring copy share the exact selected placement.
    const prepareStartInput = React.useCallback((actionId: ActionId, input: Record<string, unknown>) => ({
        ...input,
        ...(sessionId !== null || actionId === 'execution.run.start' ? { sessionId } : {}),
        ...(sessionId === null && actionId === 'review.start' ? { target: { kind: 'detached' } } : {}),
        ...(sessionId === null && workspace ? { cwd: workspace.cwd } : {}),
    }), [sessionId, workspace?.cwd]);
    const startAction = React.useCallback(async (actionId: ActionId, input: Record<string, unknown>, readinessOperationId: string,
        launchOrigin?: ExecutionRunLaunchOrigin) => {
        const rawTargets = actionId === 'execution.run.start' ? [input.backendTarget]
            : actionId === 'review.start' ? readReviewLauncherEngineIds(input) : input.backendTargetKeys;
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
        const reviewers = actionId === 'review.start' ? readReviewLauncherReviewers(input) : [];
        await admitExactTarget({ secretReferenceOverlay: input.secretReferenceOverlay !== undefined || reviewers.some(reviewer => reviewer.kind === 'engine' && reviewer.secretReferenceOverlay !== undefined),
            teamCredentialModel: input.teamCredentialModel !== undefined || reviewers.some(reviewer => reviewer.kind === 'engine' && reviewer.teamCredentialModel !== undefined),
            roleBinding: input.roleId !== undefined || reviewers.some(reviewer => reviewer.kind === 'engine' && reviewer.roleId !== undefined) }, readinessOperationId, runBackendTargets);
        return executor.execute(actionId, prepareStartInput(actionId, input),
            { ...(sessionId ? { defaultSessionId: sessionId } : {}),
                ...(machineId ? { executionRunTargetMachineId: machineId } : {}),
                ...(launchOrigin ? { executionRunLaunchOrigin: launchOrigin } : {}),
                ...(!sessionId && workspace ? { externalActionTarget: { kind: 'machine' as const, machineId: workspace.machineId } } : {}) });
    }, [admitExactTarget, executor.execute, machineId, prepareStartInput, sessionId, workspace?.machineId]);
    return { session, accountBinding, accountLifetime, exactSettings, settings, profileCatalogReady, acpCatalogReady, acpCatalogSnapshot, enabledAgentIds, defaultBackend,
        backendTarget, inheritedModelSelection, inheritedTeamCredentialModel, resolveInheritedModelLabel, inheritedConnectedServicesSelection, inheritedRoutePresentation, machineTarget, machineId, machineReachable, admitExactTarget, prepareStartInput, startAction,
        executeAction: executor.execute,
        isStartCurrent: executor.isCurrent, cancelStart: executor.cancel };
}
