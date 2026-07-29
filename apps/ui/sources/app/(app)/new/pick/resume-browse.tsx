import React from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import { DEFAULT_AGENT_ID, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries, resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolvePersistedAgentIdForBackendTarget } from '@/agents/backendCatalog/resolvePersistedAgentIdForBackendTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { ExternalSessionsBrowseScreen } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { NewSessionScreenPortalScope, useNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveResumePickerBackendTarget } from '@/components/sessions/new/navigation/resolveResumePickerBackendTarget';
import { pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { normalizeOptionalParam } from '@/profileRouteParams';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useSettings } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

type RouteParamValue = string | string[] | undefined;
type ResumeBrowseRouteParams = Readonly<{
    agentType?: AgentId | string | string[];
    providerId?: string | string[];
    backendTarget?: string | string[];
    backendTargetKey?: string | string[];
    machineId?: string | string[];
    spawnServerId?: string | string[];
    serverId?: string | string[];
    dataId?: string | string[];
}>;

function normalizeNonEmptyParam(value: RouteParamValue): string | null {
    const normalized = normalizeOptionalParam(value);
    if (typeof normalized !== 'string') return null;
    const trimmed = normalized.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function pickFirstNonEmpty(...values: readonly RouteParamValue[]): string | null {
    for (const value of values) {
        const normalized = normalizeNonEmptyParam(value);
        if (normalized) return normalized;
    }
    return null;
}

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

function isPluginLikeBackendTarget(target: BackendTargetRefV2 | null | undefined): boolean {
    return !!(target && target.kind === 'backend' && !target.configuredBackendId && !isAgentId(target.backendId));
}

function ResumeBrowsePickerScreenContent(props: Readonly<{
    params: ResumeBrowseRouteParams;
}>) {
    const router = useRouter();
    const navigation = useNavigation();
    const settings = useSettings() ?? settingsDefaults;
    const accountProfile = useAccountProfile();
    const params = props.params;

    const tempSessionData = React.useMemo(() => {
        const dataId = normalizeNonEmptyParam(params.dataId) ?? '';
        return dataId ? peekTempData<NewSessionData>(dataId) : null;
    }, [params.dataId]);
    const agentTypeParam = React.useMemo<AgentId | undefined>(() => {
        const agentTypeCandidate = pickFirstNonEmpty(params.agentType as RouteParamValue, params.providerId);
        return agentTypeCandidate && isAgentId(agentTypeCandidate) ? agentTypeCandidate : undefined;
    }, [params.agentType, params.providerId]);
    const effectiveMachineId = React.useMemo(() => {
        const directParam = normalizeNonEmptyParam(params.machineId) ?? '';
        if (directParam) return directParam;
        const fromTemp = typeof tempSessionData?.machineId === 'string' ? tempSessionData.machineId.trim() : '';
        return fromTemp || null;
    }, [params.machineId, tempSessionData?.machineId]);
    const effectiveServerId = React.useMemo(() => {
        const directParam = pickFirstNonEmpty(params.spawnServerId, params.serverId);
        return directParam || null;
    }, [params.serverId, params.spawnServerId]);
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
            backendTarget: pickFirstNonEmpty(params.backendTarget),
            backendTargetKey: pickFirstNonEmpty(params.backendTargetKey),
            agentType: agentTypeParam,
        });
    }, [agentTypeParam, params.backendTarget, params.backendTargetKey]);
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
        return resolveExplicitSelectedBuiltInAgentId(agentTypeParam, settings.lastUsedAgent);
    }, [agentTypeParam, settings.lastUsedAgent]);
    const runtimeCarrierAgentId = React.useMemo<AgentId | null>(() => {
        if (selectedBackendEntry?.catalogAgentId) {
            return selectedBackendEntry.catalogAgentId;
        }
        if (explicitSelectedBuiltInAgentId) {
            return resolvePersistedAgentIdForBackendTarget({
                backendTarget: effectiveBackendTarget,
                persistedAgentId: agentTypeParam ?? settings.lastUsedAgent,
                selectedBuiltInAgentId: explicitSelectedBuiltInAgentId,
            });
        }
        return resolveCatalogAgentIdForBackendTarget(effectiveBackendTarget);
    }, [agentTypeParam, effectiveBackendTarget, explicitSelectedBuiltInAgentId, selectedBackendEntry?.catalogAgentId, settings.lastUsedAgent]);
    const agentType = React.useMemo<AgentId>(() => {
        return runtimeCarrierAgentId ?? explicitSelectedBuiltInAgentId ?? DEFAULT_AGENT_ID;
    }, [explicitSelectedBuiltInAgentId, runtimeCarrierAgentId]);
    const externalSessionBrowseCarrierAgentId = React.useMemo<AgentId | null>(() => {
        return runtimeCarrierAgentId;
    }, [runtimeCarrierAgentId]);
    const agentOptionState = React.useMemo(() => {
        const map = readBackendNewSessionOptionStateByTargetKey(tempSessionData);
        return map?.[effectiveBackendTargetKey] ?? null;
    }, [effectiveBackendTargetKey, tempSessionData]);
    const roundTripBackendParams = React.useMemo(() => {
        return buildBackendTargetRouteParams({
            backendTarget: pickFirstNonEmpty(params.backendTarget) ?? undefined,
            backendTargetKey: pickFirstNonEmpty(params.backendTargetKey) ?? undefined,
            agentType: agentTypeParam,
            fallbackTarget: effectiveBackendTarget,
        });
    }, [agentTypeParam, effectiveBackendTarget, params.backendTarget, params.backendTargetKey]);
    const currentRouteParams = React.useMemo(() => {
        return pickNewSessionRouteParams(params);
    }, [params]);
    const awaitingCarrierProjection = React.useMemo(() => {
        const requestedBackendTargetKey = pickFirstNonEmpty(params.backendTargetKey);
        if (!requestedBackendTargetKey || !requestedBackendTargetKey.startsWith('backend:')) {
            return false;
        }
        if (daemonMergedProjection.phase !== 'loading') {
            return false;
        }
        if (isPluginLikeBackendTarget(effectiveBackendTarget) && runtimeCarrierAgentId === null) {
            return true;
        }
        return selectedBackendEntry == null && runtimeCarrierAgentId === null;
    }, [daemonMergedProjection.phase, effectiveBackendTarget, params.backendTargetKey, runtimeCarrierAgentId, selectedBackendEntry]);

    const lockScope = React.useMemo(() => {
        if (!effectiveMachineId) return null;
        if (!externalSessionBrowseCarrierAgentId) return null;
        if (!canBrowseExternalSessions({
            agentId: externalSessionBrowseCarrierAgentId,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        })) return null;
        const source = resolveExternalSessionBrowseLockedSource({
            providerId: externalSessionBrowseCarrierAgentId,
            agentOptionState,
            profile: accountProfile,
            settings,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        });
        if (!source) return null;
        return {
            machineId: effectiveMachineId,
            serverId: effectiveServerId,
            providerId: externalSessionBrowseCarrierAgentId,
            source,
        };
    }, [accountProfile, agentOptionState, daemonMergedProjectionInputs?.pluginProjectionV2, externalSessionBrowseCarrierAgentId, effectiveMachineId, effectiveServerId, settings]);

    React.useEffect(() => {
        if (lockScope || awaitingCarrierProjection) return;
        safeRouterBack({ router, navigation, fallbackHref: '/new' });
    }, [awaitingCarrierProjection, lockScope, navigation, router]);

    const headerTitle = t('externalSessions.browseTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = useNewSessionContainedModalScreenOptions({
        title: headerTitle,
        headerBackTitle,
    });

    return (
        <NewSessionScreenPortalScope>
            <Stack.Screen options={screenOptions} />
            <View style={{ flex: 1, minHeight: 0 }}>
                {lockScope ? (
                    <ExternalSessionsBrowseScreen
                        interaction="pickRemoteSessionId"
                        lockScope={lockScope}
                        onPickRemoteSessionId={(remoteSessionId) => {
                            const returnMode = setNewSessionPickerReturnParams({
                                navigation,
                                router,
                                routeParams: {
                                    ...roundTripBackendParams,
                                    resumeSessionId: remoteSessionId,
                                },
                                currentParams: currentRouteParams,
                                replaceParams: {
                                    ...roundTripBackendParams,
                                    ...(normalizeNonEmptyParam(params.dataId) ? { dataId: normalizeNonEmptyParam(params.dataId) } : {}),
                                    ...(normalizeNonEmptyParam(params.machineId) ? { machineId: normalizeNonEmptyParam(params.machineId) } : {}),
                                    ...(pickFirstNonEmpty(params.spawnServerId, params.serverId) ? { spawnServerId: pickFirstNonEmpty(params.spawnServerId, params.serverId) } : {}),
                                    resumeSessionId: remoteSessionId,
                                },
                            });
                            if (returnMode === 'dispatch') {
                                safeRouterBack({ router, navigation, fallbackHref: '/new' });
                            }
                        }}
                    />
                ) : null}
            </View>
        </NewSessionScreenPortalScope>
    );
}

export default function ResumeBrowsePickerScreen() {
    const params = useLocalSearchParams<ResumeBrowseRouteParams>();
    const serverId = pickFirstNonEmpty(params.spawnServerId, params.serverId);

    return (
        <ExternalSessionsBrowseRouteGate
            scope={{ scopeKind: 'spawn', serverId }}
        >
            <ResumeBrowsePickerScreenContent params={params} />
        </ExternalSessionsBrowseRouteGate>
    );
}
