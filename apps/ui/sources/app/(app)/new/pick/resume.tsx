import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries, resolveBuiltInAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { openDirectSessionsResumeIdPickerModal } from '@/components/sessions/directSessions/browse/openDirectSessionsResumeIdPickerModal';
import { NewSessionScreenPortalScope, createNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveResumePickerBackendTarget } from '@/components/sessions/new/navigation/resolveResumePickerBackendTarget';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { canBrowseDirectSessions, resolveDirectBrowseLockedSource } from '@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import { buildBackendTargetKey, type BackendTargetRefV1 } from '@happier-dev/protocol';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

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
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: settings.backendEnabledByTargetKey }),
            acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
            backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
        });
    }, [settings.acpCatalogSettingsV1, settings.backendEnabledByTargetKey]);
    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            agentType: params.agentType,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey]);
    const effectiveBackendTarget = React.useMemo<BackendTargetRefV1>(() => {
        return resolveResumePickerBackendTarget({
            tempBackendTarget: tempSessionData?.backendTarget ?? null,
            routeBackendTarget,
            availableBackendTargets: resolvedBackendEntries.map((entry) => entry.target),
            lastUsedAgent: settings.lastUsedAgent,
            lastUsedBackendTarget: settings.lastUsedBackendTarget,
        });
    }, [resolvedBackendEntries, routeBackendTarget, settings.lastUsedAgent, settings.lastUsedBackendTarget, tempSessionData?.backendTarget]);
    const effectiveBackendTargetKey = React.useMemo(() => {
        return buildBackendTargetKey(effectiveBackendTarget);
    }, [effectiveBackendTarget]);
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.targetKey === effectiveBackendTargetKey) ?? null;
    }, [effectiveBackendTargetKey, resolvedBackendEntries]);
    const agentType = React.useMemo<AgentId>(() => {
        return selectedBackendEntry?.builtInAgentId
            ?? resolveBuiltInAgentIdForBackendTarget(effectiveBackendTarget);
    }, [effectiveBackendTarget, selectedBackendEntry?.builtInAgentId]);
    const agentLabel = selectedBackendEntry?.title ?? t(getAgentCore(agentType).displayNameKey);
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
    const agentOptionState = React.useMemo(() => {
        const map = readBackendNewSessionOptionStateByTargetKey(tempSessionData);
        return map?.[effectiveBackendTargetKey] ?? null;
    }, [effectiveBackendTargetKey, tempSessionData]);
    const resumeBrowseEnabled = Boolean(effectiveMachineId) && canBrowseDirectSessions(agentType);
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

    const headerTitle = t('newSession.resume.pickerTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = React.useMemo(() => {
        return createNewSessionContainedModalScreenOptions({
            title: headerTitle,
            headerBackTitle,
        });
    }, [headerBackTitle, headerTitle]);

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
                        if (!effectiveMachineId) return null;
                        const source = resolveDirectBrowseLockedSource({
                            providerId: agentType as any,
                            agentOptionState,
                            profile: accountProfile,
                            settings,
                        });
                        if (!source) return null;
                        return await openDirectSessionsResumeIdPickerModal({
                            title: t('directSessions.browseTitle'),
                            webPortalTarget: modalPortalTarget,
                            lockScope: {
                                machineId: effectiveMachineId,
                                serverId: effectiveServerId,
                                providerId: agentType as any,
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
