import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';

import { DEFAULT_AGENT_ID, getAgentCore, isBundledAgentId, resolveBundledAgentIdFromContributionIdentity, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries, resolveBackendTargetOperationalAgentId, resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { NewSessionResumeSelectionContent } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import { openExternalSessionsResumeIdPickerModal } from '@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal';
import { NewSessionScreenPortalScope, useNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveResumePickerBackendTarget } from '@/components/sessions/new/navigation/resolveResumePickerBackendTarget';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { useModalPortalTarget } from '@/modal/portal/ModalPortalTarget';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import { useExternalSessionBrowseSettings } from '@/agents/catalog/useAgentUiSettings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

function resolveExplicitSelectedBuiltInAgentId(
    routeAgentType: unknown,
    lastUsedAgent: unknown,
): AgentId | null {
    if (isBundledAgentId(routeAgentType)) {
        return routeAgentType;
    }
    if (isBundledAgentId(lastUsedAgent)) {
        return lastUsedAgent;
    }
    return null;
}

export default function ResumePickerScreen() {
    const router = useRouter();
    const returnToHost = useNewSessionPickerReturnHost();
    const navigation = useNavigation();
    const modalPortalTarget = useModalPortalTarget();
    const remembered = useLastUsedBackendSelection();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
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
        // Backend entries and external-session sources read Agent declarations only.
        sections: DAEMON_AGENT_CATALOG_SECTIONS,
        machineId: effectiveMachineId,
        serverId: effectiveServerId,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const { snapshot: acpCatalog } = useAcpCatalogForServer(effectiveServerId);
    const catalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: backendEnabledByTargetKey }),
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey: backendEnabledByTargetKey,
            collapseConfiguredBackendProviderSentinels: true,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
            mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            discoveredBackendIds: daemonMergedProjectionInputs?.discoveredBackendIds ?? undefined,
        });
    }, [
        daemonMergedProjectionInputs?.discoveredBackendIds,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        acpCatalog,
        backendEnabledByTargetKey,
    ]);
    const settings = useExternalSessionBrowseSettings(daemonMergedProjectionInputs?.pluginProjectionV2, resolvedBackendEntries.map(entry => entry.agentId));
    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: params.backendTarget,
            backendTargetKey: params.backendTargetKey,
            agentType: params.agentType,
        });
    }, [params.agentType, params.backendTarget, params.backendTargetKey]);
    const effectiveBackendTarget = React.useMemo<PersistedBackendTargetRefV2>(() => {
        return resolveResumePickerBackendTarget({
            tempBackendTarget: tempSessionData?.backendTarget ?? null,
            routeBackendTarget,
            availableBackendTargets: resolvedBackendEntries.map((entry) => entry.backendTarget),
            lastUsedAgent: remembered.lastUsedAgent,
            lastUsedBackendTarget: remembered.lastUsedBackendTarget,
        });
    }, [resolvedBackendEntries, routeBackendTarget, remembered.lastUsedAgent, remembered.lastUsedBackendTarget, tempSessionData?.backendTarget]);
    const effectiveBackendTargetKey = React.useMemo(() => {
        return resolveBackendTargetKeyV2(effectiveBackendTarget);
    }, [effectiveBackendTarget]);
    const selectedBackendEntry = React.useMemo(() => {
        return resolvedBackendEntries.find((entry) => entry.backendTargetKey === effectiveBackendTargetKey) ?? null;
    }, [effectiveBackendTargetKey, resolvedBackendEntries]);
    const explicitSelectedBuiltInAgentId = React.useMemo(() => {
        return resolveExplicitSelectedBuiltInAgentId(params.agentType, remembered.lastUsedAgent);
    }, [params.agentType, remembered.lastUsedAgent]);
    const staticAgentId = React.useMemo<AgentId | null>(() => {
        if (selectedBackendEntry?.catalogAgentId) {
            return selectedBackendEntry.catalogAgentId;
        }
        if (explicitSelectedBuiltInAgentId) {
            if (effectiveBackendTarget.kind === 'agent') {
                return resolveBundledAgentIdFromContributionIdentity(effectiveBackendTarget.identity)
                    ?? explicitSelectedBuiltInAgentId;
            }
            return resolvePersistedAgentIdForBackendTarget({
                backendTarget: effectiveBackendTarget,
                persistedAgentId: params.agentType ?? remembered.lastUsedAgent,
                selectedBuiltInAgentId: explicitSelectedBuiltInAgentId,
            });
        }
        return effectiveBackendTarget.kind === 'agent'
            ? resolveBundledAgentIdFromContributionIdentity(effectiveBackendTarget.identity)
            : resolveCatalogAgentIdForBackendTarget(effectiveBackendTarget);
    }, [effectiveBackendTarget, explicitSelectedBuiltInAgentId, params.agentType, selectedBackendEntry?.catalogAgentId, remembered.lastUsedAgent]);
    const operationalAgentId = React.useMemo(() => {
        return resolveBackendTargetOperationalAgentId({
            backendTarget: effectiveBackendTarget,
            selectedEntry: selectedBackendEntry,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById,
        });
    }, [daemonMergedProjectionInputs?.mergedProviderProjectionById, effectiveBackendTarget, selectedBackendEntry]);
    const agentType = operationalAgentId ?? staticAgentId ?? DEFAULT_AGENT_ID;
    const agentLabel = selectedBackendEntry?.title
        ?? (() => {
            const displayNameKey = getAgentCore(agentType)?.displayNameKey;
            return displayNameKey ? t(displayNameKey) : null;
        })();
    const agentOptionState = React.useMemo(() => {
        const map = readBackendNewSessionOptionStateByTargetKey(tempSessionData);
        return map?.[effectiveBackendTargetKey] ?? null;
    }, [effectiveBackendTargetKey, tempSessionData]);
    const resumeBrowseEnabled = catalogReady && externalSessionsFeatureEnabled
        && Boolean(effectiveMachineId)
        && operationalAgentId !== null
        && canBrowseExternalSessions({
            agentId: operationalAgentId,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
            machineId: effectiveMachineId,
            // This screen only ever picks a remote session id to resume, so it
            // must also admit resume-only listing sources.
            interaction: 'pickRemoteSessionId',
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
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);

    const handleSave = React.useCallback((nextValue: string) => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                ...roundTripBackendParams,
                resumeSessionId: nextValue,
            },
            currentParams: currentRouteParams,
            returnToHost,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                resumeSessionId: nextValue,
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [returnToHost, currentRouteParams, navigation, roundTripBackendParams, router, params.dataId, params.machineId, params.spawnServerId]);

    const handleClear = React.useCallback(() => {
        const returnMode = setNewSessionPickerReturnParams({
            navigation,
            router,
            routeParams: {
                ...roundTripBackendParams,
                resumeSessionId: '',
            },
            currentParams: currentRouteParams,
            returnToHost,
            replaceParams: {
                ...roundTripBackendParams,
                ...(typeof params.dataId === 'string' && params.dataId.trim().length > 0 ? { dataId: params.dataId } : {}),
                ...(typeof params.machineId === 'string' && params.machineId.trim().length > 0 ? { machineId: params.machineId } : {}),
                ...(typeof params.spawnServerId === 'string' && params.spawnServerId.trim().length > 0 ? { spawnServerId: params.spawnServerId } : {}),
                resumeSessionId: '',
            },
        });
        if (returnMode === 'dispatch') {
            safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
        }
    }, [returnToHost, currentRouteParams, navigation, roundTripBackendParams, router, params.dataId, params.machineId, params.spawnServerId]);

    React.useEffect(() => {
        if (hasUsableRouteState) return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [hasUsableRouteState, navigation, pickerFallbackHref, router]);

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
                onClose={() => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref })}
                agentType={agentType}
                agentLabel={agentLabel}
                resumeBrowse={resumeBrowseEnabled ? {
                    enabled: true,
                    onBrowse: async () => {
                        if (!effectiveMachineId || !operationalAgentId) return null;
                        const accountScope = getActiveServerAccountScope();
                        const source = resolveExternalSessionBrowseLockedSource({
                            accountScope,
                            serverId: effectiveServerId,
                            providerId: operationalAgentId,
                            machineId: effectiveMachineId,
                            agentOptionState,
                            profile: accountProfile,
                            agentSettings: settings,
                            labelsByKey: getConnectedMetadataCatalog(accountScope).labelsByKey,
                            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
                            interaction: 'pickRemoteSessionId',
                        });
                        if (!source) return null;
                        return await openExternalSessionsResumeIdPickerModal({
                            title: t('externalSessions.browseTitle'),
                            webPortalTarget: modalPortalTarget,
                            lockScope: {
                                machineId: effectiveMachineId,
                                serverId: effectiveServerId,
                                providerId: operationalAgentId,
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
