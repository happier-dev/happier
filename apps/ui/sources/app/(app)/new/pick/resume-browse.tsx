import { useLastUsedBackendSelection } from '@/hooks/session/useLastUsedBackendSelection';
import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useNavigation } from '@react-navigation/native';
import { View } from 'react-native';

import { isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { getEnabledAgentIds } from '@/agents/catalog/enabled';
import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from '@/agents/backendCatalog/backendTargetRouteParams';
import { getResolvedBackendCatalogEntries, resolveBackendTargetOperationalAgentId } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useResumeBrowseCatalog } from '@/components/sessions/external/browse/useResumeBrowseCatalog';
import { ExternalSessionsBrowseScreen } from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import { ExternalSessionsBrowseRouteGate } from '@/components/sessions/external/browse/ExternalSessionsBrowseRouteGate';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { canBrowseExternalSessions, resolveExternalSessionBrowseLockedSource } from '@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption';
import { NewSessionScreenPortalScope, useNewSessionContainedModalScreenOptions } from '@/components/sessions/new/navigation/newSessionContainedModalScreen';
import { resolveResumePickerBackendTarget } from '@/components/sessions/new/navigation/resolveResumePickerBackendTarget';
import { buildNewSessionPickerFallbackHref, pickNewSessionRouteParams, setNewSessionPickerReturnParams } from '@/components/sessions/new/navigation/setNewSessionPickerReturnParams';
import { useNewSessionPickerReturnHost } from '@/components/sessions/new/navigation/newSessionEntry';
import { NewSessionPickerRouteScreen } from '@/components/sessions/new/navigation/NewSessionPickerRouteScreen';
import { normalizeOptionalParam } from '@/profileRouteParams';
import { readBackendNewSessionOptionStateByTargetKey } from '@/utils/sessions/backendNewSessionOptionState';
import { peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { useSetting } from '@/sync/domains/state/storage';
import { useExternalSessionBrowseSettings } from '@/agents/catalog/useAgentUiSettings';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getConnectedMetadataCatalog } from '@/sync/store/settings/connectedMetadataCatalogSnapshot';
import { useProfile as useAccountProfile } from '@/sync/store/hooks';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

type RouteParamValue = string | string[] | undefined;
type ResumeBrowseRouteParams = Readonly<{
    agentType?: AgentId | string | string[];
    newSessionHostDraftId?: string;
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

function ResumeBrowsePickerScreenContent(props: Readonly<{
    params: ResumeBrowseRouteParams;
}>) {
    const router = useRouter();
    const returnToHost = useNewSessionPickerReturnHost();
    const navigation = useNavigation();
    const remembered = useLastUsedBackendSelection();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const accountProfile = useAccountProfile();
    const params = props.params;

    const tempSessionData = React.useMemo(() => {
        const dataId = normalizeNonEmptyParam(params.dataId) ?? '';
        return dataId ? peekTempData<NewSessionData>(dataId) : null;
    }, [params.dataId]);
    const agentTypeParam = React.useMemo<AgentId | undefined>(() => {
        const agentTypeCandidate = pickFirstNonEmpty(params.agentType as RouteParamValue, params.providerId);
        return agentTypeCandidate && isBundledAgentId(agentTypeCandidate) ? agentTypeCandidate : undefined;
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
    const inventory = useResumeBrowseCatalog(effectiveMachineId, effectiveServerId);
    const daemonMergedProjection = inventory.projection;
    const daemonMergedProjectionInputs = daemonMergedProjection.phase === 'ready' ? daemonMergedProjection.inputs : null;
    const acpCatalog = inventory.catalog;
    const resolvedBackendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds: getEnabledAgentIds({ backendEnabledByTargetKey: backendEnabledByTargetKey }),
            acpCatalogSnapshot: acpCatalog,
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
    const routeBackendTarget = React.useMemo(() => {
        return resolveBackendTargetFromRouteParams({
            backendTarget: pickFirstNonEmpty(params.backendTarget),
            backendTargetKey: pickFirstNonEmpty(params.backendTargetKey),
            agentType: agentTypeParam,
        });
    }, [agentTypeParam, params.backendTarget, params.backendTargetKey]);
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
    const operationalAgentId = React.useMemo(() => {
        return resolveBackendTargetOperationalAgentId({
            backendTarget: effectiveBackendTarget,
            selectedEntry: selectedBackendEntry,
            mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById,
        });
    }, [daemonMergedProjectionInputs?.mergedProviderProjectionById, effectiveBackendTarget, selectedBackendEntry]);
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
    const pickerFallbackHref = React.useMemo(() => buildNewSessionPickerFallbackHref(params), [params]);
    /**
     * A loading projection is a retained loading state, never a dismissal trigger.
     *
     * `lockScope` is null while the daemon projection is in flight for a BUNDLED Agent
     * for exactly the same reason it is null for an unresolved plugin carrier: the
     * projection that decides browse capability and the locked source has not arrived
     * yet. Narrowing the wait to `backend:*` carriers made a cold deep link or reload of
     * this picker pop itself before it could mount. Only an authoritative non-loading
     * phase (`ready`, `unsupported`, `error`, or `idle` when there is no machine at all)
     * may prove the lock unavailable.
     */
    const awaitingProjection = inventory.phase === 'loading';

    const settings = useExternalSessionBrowseSettings(daemonMergedProjectionInputs?.pluginProjectionV2, operationalAgentId ? [operationalAgentId] : []);
    const lockScope = React.useMemo(() => {
        if (inventory.phase !== 'ready') return null;
        if (!effectiveMachineId) return null;
        if (!operationalAgentId) return null;
        if (!canBrowseExternalSessions({
            agentId: operationalAgentId,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
            machineId: effectiveMachineId,
            // This route renders the `pickRemoteSessionId` browse screen below,
            // so capability and lock resolution must ask the same interaction.
            interaction: 'pickRemoteSessionId',
        })) return null;
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
        return {
            machineId: effectiveMachineId,
            serverId: effectiveServerId,
            providerId: operationalAgentId,
            source,
        };
    }, [accountProfile, agentOptionState, inventory.phase, daemonMergedProjectionInputs?.pluginProjectionV2, effectiveMachineId, effectiveServerId, operationalAgentId, settings]);

    React.useEffect(() => {
        if (lockScope || inventory.phase !== 'ready') return;
        safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
    }, [inventory.phase, lockScope, navigation, pickerFallbackHref, router]);

    const headerTitle = t('externalSessions.browseTitle');
    const headerBackTitle = t('common.cancel');
    const screenOptions = useNewSessionContainedModalScreenOptions({
        title: headerTitle,
        headerBackTitle,
    });

    return (
        <NewSessionScreenPortalScope>
            <NewSessionPickerRouteScreen options={screenOptions}>
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
                                    returnToHost,
                                    replaceParams: {
                                        ...roundTripBackendParams,
                                        ...(normalizeNonEmptyParam(params.dataId) ? { dataId: normalizeNonEmptyParam(params.dataId) } : {}),
                                        ...(normalizeNonEmptyParam(params.machineId) ? { machineId: normalizeNonEmptyParam(params.machineId) } : {}),
                                        ...(pickFirstNonEmpty(params.spawnServerId, params.serverId) ? { spawnServerId: pickFirstNonEmpty(params.spawnServerId, params.serverId) } : {}),
                                        resumeSessionId: remoteSessionId,
                                    },
                                });
                                if (returnMode === 'dispatch') {
                                    safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref });
                                }
                            }}
                        />
                    ) : inventory.phase === 'unavailable' ? (
                        <SurfaceStateCard
                            testID="external-sessions-browse-route-unavailable"
                            kind="unavailable"
                            accessibilitySemantics="alert"
                            title={t('common.unavailable')}
                            reason={t('externalSessions.browseRouteAvailabilityUnknownSubtitle')}
                            diagnosticCode={inventory.reason}
                            action={{ label: t('common.retry'), onPress: inventory.retry }}
                            secondaryAction={{
                                label: t('common.close'),
                                onPress: () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
                            }}
                        />
                    ) : awaitingProjection ? (
                        <SurfaceStateCard
                            testID="external-sessions-browse-route-loading"
                            kind="loading"
                            accessibilitySemantics="status"
                            title={t('common.loading')}
                            reason={t('externalSessions.settingsIntegrationInventoryLoadingSubtitle')}
                            secondaryAction={{
                                label: t('common.close'),
                                onPress: () => safeRouterBack({ router, navigation, fallbackHref: pickerFallbackHref }),
                            }}
                        />
                    ) : null}
                </View>
            </NewSessionPickerRouteScreen>
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
