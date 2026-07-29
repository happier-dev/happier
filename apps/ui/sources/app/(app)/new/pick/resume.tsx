import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

import { DEFAULT_AGENT_ID, getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries, resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { openExternalSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal';
import { NewSessionScreenPortalScope, useNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveResumePickerBackendTarget } from '@/components/sessions/new/navigation/resolveResumePickerBackendTarget';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

function resolveExplicitSelectedBuiltInAgentId(
    routeAgentType: unknown,
    lastUsedAgent: unknown,
): AgentId | null {
    if (isAgentId(routeAgentType)) {
        return routeAgentType;
    }
    if (isAgentId(lastUsedAgent)) {
        return lastUsedAgent;
    }
    return null;
}

export default function ResumePickerScreen() {
    const router = useRouter();
    const navigation = useNavigation();
    const modalPortalTarget = useModalPortalTarget();
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const params = useLocalSearchParams<{
        currentResumeId?: string;
        agentType?: AgentId;
        backendTarget?: string;
        backendTargetKey?: string;
        machineId?: string;
        spawnServerId?: string;
        dataId?: string;
    }>();

    const [inputValue, setInputValue] = React.useState(params.currentResumeId || '');
    const tempSessionData = React.useMemo(() => {
        const dataId = typeof params.dataId === 'string' ? params.dataId.trim() : '';
        return dataId ? peekTempData<NewSessionData>(dataId) : null;
    }, [params.dataId]);
    const hasUsableRouteState = Boolean(
        (typeof params.dataId === 'string' && params.dataId.trim().length > 0)
        || (typeof params.machineId === 'string' && params.machineId.trim().length > 0)
        || (typeof params.currentResumeId === 'string' && params.currentResumeId.trim().length > 0),
    );
    const effectiveMachineId = React.useMemo(() => {
        const directParam = typeof params.machineId === 'string' ? params.machineId.trim() : '';
        if (directParam) return directParam;
        const fromTemp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        return fromTemp || null;
    }, [params.machineId, tempSessionData?.machineId]);
    const effectiveServerId = React.useMemo(() => {
        const directParam = typeof params.spawnServerId === 'string' ? params.spawnServerId.trim() : '';
        return directParam || null;
    }, [params.spawnServerId]);
    const externalSessionsFeatureEnabled = useFeatureEnabled('sessions.direct', {
        scopeKind: 'spawn',
        serverId: effectiveServerId,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: effectiveMachineId,
        serverId: effectiveServerId,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
        });
    }, [
        daemonMergedProjectionInputs?.discoveredBackendIds,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);
    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            agentType: params.agentType,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey]);
    const effectiveBackendTarget = React.useMemo<BackendTargetRefV2>(() => {
        return resolveResumePickerBackendTarget({
            tempBackendTarget: tempSessionData?.backendTarget ?? null,
            routeBackendTarget,
            availableBackendTargets: resolvedBackendEntries.map((entry) => entry.backendTarget),
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
        });
    }, [resolvedBackendEntries, routeBackendTarget, settings.lastUsedAgent, settings.lastUsedBackendTarget, tempSessionData?.backendTarget]);
    const effectiveBackendTargetKey = React.useMemo(() => {
        return resolveBackendTargetKeyV2(effectiveBackendTarget);
    }, [effectiveBackendTarget]);
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.backendTargetKey === effectiveBackendTargetKey) ?? null;
    }, [effectiveBackendTargetKey, resolvedBackendEntries]);
    const explicitSelectedBuiltInAgentId = React.useMemo(() => {
        return resolveExplicitSelectedBuiltInAgentId(params.agentType, settings.lastUsedAgent);
    }, [params.agentType, settings.lastUsedAgent]);
    const runtimeCarrierAgentId = React.useMemo<AgentId | null>(() => {
        if (selectedBackendEntry?.catalogAgentId) {
            return selectedBackendEntry.catalogAgentId;
        }
        if (explicitSelectedBuiltInAgentId) {
            return resolvePersistedAgentIdForBackendTarget({
                backendTarget: effectiveBackendTarget,
                persistedAgentId: params.agentType ?? settings.lastUsedAgent,
                selectedBuiltInAgentId: explicitSelectedBuiltInAgentId,
            });
        }
        return resolveCatalogAgentIdForBackendTarget(effectiveBackendTarget);
    }, [effectiveBackendTarget, explicitSelectedBuiltInAgentId, params.agentType, selectedBackendEntry?.catalogAgentId, settings.lastUsedAgent]);
    const agentType = React.useMemo<AgentId>(() => {
        return runtimeCarrierAgentId ?? explicitSelectedBuiltInAgentId ?? DEFAULT_AGENT_ID;
    }, [explicitSelectedBuiltInAgentId, runtimeCarrierAgentId]);
    const externalSessionBrowseCarrierAgentId = React.useMemo<AgentId | null>(() => {
        return runtimeCarrierAgentId;
    }, [runtimeCarrierAgentId]);
    const agentLabel = selectedBackendEntry?.title ?? t(getAgentCore(agentType).displayNameKey);
    const agentOptionState = React.useMemo(() => {
        const map = readBackendNewSessionOptionStateByTargetKey(tempSessionData);
        return map?.[effectiveBackendTargetKey] ?? null;
    }, [effectiveBackendTargetKey, tempSessionData]);
    const resumeBrowseEnabled = externalSessionsFeatureEnabled
        && Boolean(effectiveMachineId)
        && externalSessionBrowseCarrierAgentId !== null
        && canBrowseExternalSessions({
            agentId: externalSessionBrowseCarrierAgentId,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        });
    const roundTripBackendParams = React.useMemo(() => {
        return buildBackendTargetRouteParams({
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            agentType: params.agentType,
            fallbackTarget: effectiveBackendTarget,
        });
    }, [effectiveBackendTarget, params.agentType, params.backendTarget, params.backendTargetKey]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);

    const handleSave = React.useCallback((nextValue: string) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                ...roundTripBackendParams,
                resumeSessionId: nextValue,
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                resumeSessionId: nextValue,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [currentRouteParams, navigation, roundTripBackendParams, router, params.dataId, params.machineId, params.spawnServerId]);

    const handleClear = React.useCallback(() => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                ...roundTripBackendParams,
                resumeSessionId: '',
            },
            currentParams: currentRouteParams,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                resumeSessionId: '',
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: '/new' });
        }
    }, [currentRouteParams, navigation, roundTripBackendParams, router, params.dataId, params.machineId, params.spawnServerId]);

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [hasUsableRouteState, navigation, router]);

    const headerTitle = t('newSession.resume.pickerTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = useNewSessionContainedModalScreenOptions({
        title: headerTitle,
        headerBackTitle,
    });

    return (
        <NewSessionScreenPortalScope>
            <Stack.Screen options={screenOptions} />
            <NewSessionResumeSelectionContent
                value={inputValue}
                onChangeValue={setInputValue}
                onSave={handleSave}
                onClear={handleClear}
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: '/new' })}
                agentType={agentType}
                agentLabel={agentLabel}
                resumeBrowse={resumeBrowseEnabled ? {
                    enabled: true,
                    onBrowse: async () => {
                        if (!effectiveMachineId || !externalSessionBrowseCarrierAgentId) return null;
                        const source = resolveExternalSessionBrowseLockedSource({
                            providerId: externalSessionBrowseCarrierAgentId,
                            agentOptionState,
                            profile: accountProfile,
                            settings,
                            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
                        });
                        if (!source) return null;
                        return await openExternalSessionsResumeIdPickerModal({
                            title: t('externalSessions.browseTitle'),
                            webPortalTarget: modalPortalTarget,
                            lockScope: {
                                machineId: effectiveMachineId,
                                serverId: effectiveServerId,
                                providerId: externalSessionBrowseCarrierAgentId,
                                source,
                            },
                        });
                    },
                } : null}
                showInlineHeader={false}
            />
        </NewSessionScreenPortalScope>
    );
}
