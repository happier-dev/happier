import * as React from 'react';
import { View } from 'react-native';
import {
    readExternalSessionsSettingsV1,
    removeExternalSessionsAutoLinkSourcePolicyV1,
    upsertExternalSessionsAutoLinkSourcePolicyV1,
    type ExternalSessionsAgentId,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { PopoverScope } from '@/components/ui/popover';
import { Modal } from '@/modal';
import { useAllMachines, useSetting } from '@/sync/domains/state/storage';
import { machineExternalSessionLinkEnsure } from '@/sync/ops/machineExternalSessions';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { sync } from '@/sync/sync';
import type { Theme } from '@/theme';
import { t } from '@/text';

import { getPreferredExternalSessionBrowseProviderId } from './getPreferredExternalSessionBrowseProviderId';
import {
    listExternalSessionBrowseProviderIds,
    resolveExternalSessionBrowseCompatibleLinkSource,
    resolveExternalSessionBrowseLinkEnsureRequestExtras,
    resolveExternalSessionBrowseSourceOption,
    resolveExternalSessionBrowseSourceOptions,
} from './resolveExternalSessionBrowseSourceOptions';
import { ExternalSessionBrowseCandidatesList } from './ExternalSessionBrowseCandidatesList';
import { Icon } from '@/components/ui/icons/Icon';
import {
    readExternalSessionBrowseCandidateKey,
    readExternalSessionBrowseCandidatePath,
    useExternalSessionBrowseCandidates,
    type ExternalSessionBrowseCandidate,
} from './useExternalSessionBrowseCandidates';
import {
    resolveExternalSessionBrowseRpcErrorMessage,
    resolveExternalSessionBrowseThrownErrorMessage,
} from './externalSessionBrowseErrorPresentation';

type ExternalSessionBrowseProviderId = ExternalSessionsAgentId;
type AppTheme = Theme;

const EXTERNAL_SESSION_BROWSE_SEARCH_DEBOUNCE_MS = 250;

export type ExternalSessionsBrowseScopeLock = Readonly<{
    machineId: string;
    serverId?: string | null;
    providerId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
}>;

export type ExternalSessionsBrowseInteraction = 'openSession' | 'pickRemoteSessionId';

function getPreferredMachineId(
    machines: readonly Readonly<{ id: string; active?: boolean }>[],
    selectedMachineId: string | null,
): string | null {
    const firstMachineId = machines[0]?.id ?? null;
    if (!firstMachineId) return null;
    if (selectedMachineId && machines.some((machine) => machine.id === selectedMachineId)) {
        return selectedMachineId;
    }
    return machines.find((machine) => machine.active)?.id ?? firstMachineId;
}

const stylesheet = StyleSheet.create((theme: AppTheme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    filtersGroup: {
        marginTop: 0,
    },
    filtersGroupContainer: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        shadowOpacity: 0,
        elevation: 0,
        marginHorizontal: 12,
    },
    lockedScopeSummary: {
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
}));

export const ExternalSessionsBrowseScreen = React.memo((props: Readonly<{
    interaction?: ExternalSessionsBrowseInteraction;
    lockScope?: ExternalSessionsBrowseScopeLock | null;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
    onRequestClose?: () => void;
}>) => {
    const interaction: ExternalSessionsBrowseInteraction = props.interaction ?? 'openSession';
    const lockScope = props.lockScope ?? null;
    const locked = Boolean(lockScope);
    const router = useRouter();
    const { theme } = useUnistyles() as { theme: AppTheme };
    const styles = stylesheet;
    const machines = useAllMachines();
    const profile = useProfile();
    const settings = useSettings();
    const activeServerId = useActiveServerSnapshot().serverId;
    const externalSessionsSettings = readExternalSessionsSettingsV1(
        useSetting('externalSessionsSettingsV1'),
    );
    const autoLinkMutationPendingRef = React.useRef(false);
    const linkingSessionIdRef = React.useRef<string | null>(null);
    const [autoLinkMutationPending, setAutoLinkMutationPending] = React.useState(false);
    const [daemonProjectionRefreshKey, setDaemonProjectionRefreshKey] = React.useState(0);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => (
        lockScope?.machineId ?? getPreferredMachineId(machines, null)
    ));
    const effectiveSelectedMachineId = React.useMemo(() => {
        if (lockScope) return lockScope.machineId;
        return getPreferredMachineId(machines, selectedMachineId);
    }, [lockScope, machines, selectedMachineId]);
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: effectiveSelectedMachineId,
        serverId: lockScope?.serverId ?? null,
        refreshKey: daemonProjectionRefreshKey,
        retainInputsAcrossScopeChange: true,
    });
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;
    const daemonMergedProjectionReady = daemonMergedProjection.phase === 'ready';
    const browseProviderIds = React.useMemo(
        () => listExternalSessionBrowseProviderIds({
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
        }),
        [daemonMergedProjectionInputs?.pluginProjectionV2],
    );
    const providers = React.useMemo<ReadonlyArray<Readonly<{
        id: ExternalSessionBrowseProviderId;
        label: string;
        iconAgentId: string;
    }>>>(
        () => browseProviderIds.map((providerId) => {
            const projection = resolveAgentCatalogProjection(providerId, {
                enabledAgentIds: browseProviderIds,
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
                mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            });
            return {
                id: providerId,
                label: projection.title,
                iconAgentId: projection.iconAgentId ?? providerId,
            };
        }),
        [
            browseProviderIds,
            daemonMergedProjectionInputs?.mergedBackendProjectionById,
            daemonMergedProjectionInputs?.mergedProviderProjectionById,
            settings.acpCatalogSettingsV1,
            settings.backendEnabledByTargetKey,
        ],
    );
    const providerIds = React.useMemo<readonly ExternalSessionBrowseProviderId[]>(() => providers.map((provider) => provider.id), [providers]);
    const [selectedProviderId, setSelectedProviderId] = React.useState<ExternalSessionBrowseProviderId | null>(() => (
        lockScope?.providerId ?? getPreferredExternalSessionBrowseProviderId(providerIds, null)
    ));
    const sourceOptions = React.useMemo(() => {
        if (lockScope) {
            const resolvedOption = resolveExternalSessionBrowseSourceOption({
                providerId: lockScope.providerId,
                profile,
                settings,
                projection: daemonMergedProjectionInputs?.pluginProjectionV2,
                source: lockScope.source,
                activeServerId,
            });
            return [{
                key: 'locked',
                label: resolvedOption?.label ?? t('externalSessions.browseSources'),
                ...(resolvedOption?.detail ? { detail: resolvedOption.detail } : {}),
                source: lockScope.source,
            }];
        }
        if (!selectedProviderId) return [];
        return resolveExternalSessionBrowseSourceOptions({
            providerId: selectedProviderId,
            profile,
            settings,
            projection: daemonMergedProjectionInputs?.pluginProjectionV2,
            activeServerId,
        });
    }, [activeServerId, daemonMergedProjectionInputs?.pluginProjectionV2, lockScope, profile, selectedProviderId, settings]);
    const [selectedSourceKey, setSelectedSourceKey] = React.useState<string | null>(() => (
        lockScope ? 'locked' : sourceOptions[0]?.key ?? null
    ));
    const [linkingSessionId, setLinkingSessionId] = React.useState<string | null>(null);
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [providerMenuOpen, setProviderMenuOpen] = React.useState(false);
    const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [candidateSearchTerm, setCandidateSearchTerm] = React.useState('');
    const popoverBoundaryRef = React.useRef<View>(null);
    const selectedAgentProjection = React.useMemo(() => (
        selectedProviderId
            ? resolveAgentCatalogProjection(selectedProviderId, {
                enabledAgentIds: browseProviderIds,
                backendEnabledByTargetKey: settings.backendEnabledByTargetKey,
                acpCatalogSettingsV1: settings.acpCatalogSettingsV1,
                mergedProviderProjectionById: daemonMergedProjectionInputs?.mergedProviderProjectionById ?? null,
                mergedBackendProjectionById: daemonMergedProjectionInputs?.mergedBackendProjectionById ?? null,
            })
            : null
    ), [
        browseProviderIds,
        daemonMergedProjectionInputs?.mergedBackendProjectionById,
        daemonMergedProjectionInputs?.mergedProviderProjectionById,
        selectedProviderId,
        settings.acpCatalogSettingsV1,
        settings.backendEnabledByTargetKey,
    ]);

    React.useEffect(() => {
        if (lockScope) return;
        if (effectiveSelectedMachineId && effectiveSelectedMachineId !== selectedMachineId) {
            setSelectedMachineId(effectiveSelectedMachineId);
        }
    }, [effectiveSelectedMachineId, lockScope, selectedMachineId]);

    React.useEffect(() => {
        if (lockScope) return;
        const preferredProviderId = getPreferredExternalSessionBrowseProviderId(providerIds, selectedProviderId);
        if (preferredProviderId !== selectedProviderId) {
            setSelectedProviderId(preferredProviderId);
        }
    }, [lockScope, providerIds, selectedProviderId]);

    React.useEffect(() => {
        if (lockScope) {
            if (selectedSourceKey !== 'locked') {
                setSelectedSourceKey('locked');
            }
            return;
        }
        const defaultKey = sourceOptions[0]?.key ?? null;
        if (!defaultKey) {
            setSelectedSourceKey(null);
            return;
        }
        const hasSelectedSource = sourceOptions.some((option) => option.key === selectedSourceKey);
        if (!hasSelectedSource) {
            setSelectedSourceKey(defaultKey);
        }
    }, [lockScope, selectedSourceKey, sourceOptions]);

    const selectedSource = React.useMemo(
        () => lockScope?.source ?? sourceOptions.find((option) => option.key === selectedSourceKey)?.source ?? sourceOptions[0]?.source ?? null,
        [lockScope, selectedSourceKey, sourceOptions],
    );
    const selectedSourceLabel = React.useMemo(() => {
        const option = sourceOptions.find((candidate) => candidate.key === selectedSourceKey)
            ?? sourceOptions[0];
        return option
            ? [option.label, option.detail].filter(Boolean).join(' · ')
            : null;
    }, [selectedSourceKey, sourceOptions]);
    const machineMenuItems = React.useMemo(() => machines.map((machine) => ({
        id: machine.id,
        title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
        subtitle: machine.active ? t('status.activeNow') : t('status.offline'),
        icon: <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
    })), [machines, theme.colors.text.secondary]);
    const providerMenuItems = React.useMemo(() => providers.map((provider) => ({
        id: provider.id,
        title: provider.label,
        icon: <AgentIcon agentId={provider.iconAgentId} size={18} />,
    })), [providers, theme.colors.text.secondary]);
    const sourceMenuItems = React.useMemo(() => sourceOptions.map((sourceOption) => ({
        id: sourceOption.key,
        title: sourceOption.label,
        subtitle: sourceOption.detail,
        icon: <Icon name="folder-open" size={16} color={theme.colors.text.secondary} />,
    })), [sourceOptions, theme.colors.text.secondary]);
    const formatMachineTriggerSubtitle = React.useCallback((selectedItem: Readonly<{ title: string; subtitle?: React.ReactNode }> | null) => {
        if (!selectedItem) return null;
        const statusLabel = typeof selectedItem.subtitle === 'string' ? selectedItem.subtitle.trim() : '';
        return statusLabel ? `${selectedItem.title} · ${statusLabel}` : selectedItem.title;
    }, []);
    const formatSelectedTitleSubtitle = React.useCallback((selectedItem: Readonly<{ title: string }> | null) => {
        return selectedItem?.title ?? null;
    }, []);

    React.useEffect(() => {
        const trimmedSearchQuery = searchQuery.trim();
        if (!trimmedSearchQuery) {
            setCandidateSearchTerm('');
            return undefined;
        }

        const timeoutId = setTimeout(() => {
            setCandidateSearchTerm(trimmedSearchQuery);
        }, EXTERNAL_SESSION_BROWSE_SEARCH_DEBOUNCE_MS);

        return () => {
            clearTimeout(timeoutId);
        };
    }, [searchQuery]);

    const {
        candidates,
        candidatesAuthoritative,
        nextCursor,
        paginationRequestKey,
        loading,
        loadingMore,
        searchAugmenting,
        searchIncomplete,
        annotationsIncomplete,
        preparation,
        preparationStopped,
        cancelled,
        autoLinkPolicyScope,
        error,
        loadMore,
        cancelPreparation,
        reload,
    } = useExternalSessionBrowseCandidates({
        machineId: effectiveSelectedMachineId,
        serverId: lockScope?.serverId ?? null,
        providerId: selectedProviderId,
        source: selectedSource,
        searchTerm: candidateSearchTerm,
        enabled: daemonMergedProjectionReady,
    });
    const rootRefreshFailed = error !== null && nextCursor === null;
    /**
     * Whether a candidate on screen may be acted on. This is a capability fact about
     * the listing's authority, not a liveness fact about how much of it has arrived:
     * linking needs a machine, an Agent, a source and the candidate's own identity,
     * and a row the current scope's still-building index has already served carries
     * all four. Such a row opens while the rest of the index keeps building.
     *
     * `loading` must never gate this. It is also true for every progress round-trip
     * of an in-progress index — thousands of them on a large corpus — and the rows
     * that index serves are live throughout. Rows retained from a superseded request
     * keep their inert treatment through `candidatesAuthoritative`, which is false
     * until the request owning the current scope has published.
     */
    const candidateActionsAllowed = daemonMergedProjectionReady
        && candidatesAuthoritative
        && !rootRefreshFailed;
    const candidateActionAuthorityKey = React.useMemo(() => JSON.stringify({
        machineId: effectiveSelectedMachineId,
        serverId: lockScope?.serverId ?? null,
        providerId: selectedProviderId,
        source: selectedSource,
        interaction,
    }), [
        effectiveSelectedMachineId,
        interaction,
        lockScope?.serverId,
        selectedProviderId,
        selectedSource,
    ]);
    const candidateActionAuthorityRef = React.useRef({
        key: candidateActionAuthorityKey,
        generation: 0,
    });
    if (candidateActionAuthorityRef.current.key !== candidateActionAuthorityKey) {
        candidateActionAuthorityRef.current = {
            key: candidateActionAuthorityKey,
            generation: candidateActionAuthorityRef.current.generation + 1,
        };
    }
    const candidateActionAuthorityGeneration = candidateActionAuthorityRef.current.generation;
    const linkRequestTokenRef = React.useRef(0);
    const autoLinkPolicyEnabled = React.useMemo(() => {
        if (!effectiveSelectedMachineId || !autoLinkPolicyScope) return false;
        return externalSessionsSettings?.autoLinkSourcePolicies.some((policy) => (
            policy.machineId === effectiveSelectedMachineId
            && policy.sourcePolicyId === autoLinkPolicyScope.sourcePolicyId
            && policy.qualifiedIdentity.agent.pluginId
                === autoLinkPolicyScope.qualifiedIdentity.agent.pluginId
            && policy.qualifiedIdentity.agent.localId
                === autoLinkPolicyScope.qualifiedIdentity.agent.localId
            && policy.qualifiedIdentity.source.kind
                === autoLinkPolicyScope.qualifiedIdentity.source.kind
            && policy.qualifiedIdentity.source.contractVersion
                === autoLinkPolicyScope.qualifiedIdentity.source.contractVersion
        )) === true;
    }, [autoLinkPolicyScope, effectiveSelectedMachineId, externalSessionsSettings]);
    const setAutoLinkPolicyEnabled = React.useCallback(async (enabled: boolean) => {
        if (
            !effectiveSelectedMachineId
            || !autoLinkPolicyScope
            || autoLinkMutationPendingRef.current
        ) return;
        autoLinkMutationPendingRef.current = true;
        setAutoLinkMutationPending(true);
        try {
            await sync.mutateAccountSettings((raw) => ({
                ...raw,
                externalSessionsSettingsV1: enabled
                    ? upsertExternalSessionsAutoLinkSourcePolicyV1(
                        raw.externalSessionsSettingsV1,
                        {
                            machineId: effectiveSelectedMachineId,
                            qualifiedIdentity: autoLinkPolicyScope.qualifiedIdentity,
                            sourcePolicyId: autoLinkPolicyScope.sourcePolicyId,
                            enabledAtMs: Date.now(),
                        },
                    )
                    : removeExternalSessionsAutoLinkSourcePolicyV1(
                        raw.externalSessionsSettingsV1,
                        {
                            machineId: effectiveSelectedMachineId,
                            qualifiedIdentity: autoLinkPolicyScope.qualifiedIdentity,
                            sourcePolicyId: autoLinkPolicyScope.sourcePolicyId,
                        },
                    ),
            }));
        } catch {
            await Modal.alert(
                t('common.error'),
                t('externalSessions.settingsAutoLinkUpdateFailed'),
            );
        } finally {
            autoLinkMutationPendingRef.current = false;
            setAutoLinkMutationPending(false);
        }
    }, [autoLinkPolicyScope, effectiveSelectedMachineId]);
    const selectedMachineIsOffline = React.useMemo(() => {
        if (!effectiveSelectedMachineId) return false;
        return machines.find((machine) => machine.id === effectiveSelectedMachineId)?.active === false;
    }, [effectiveSelectedMachineId, machines]);
    const selectedMachineLabel = React.useMemo(() => {
        const machine = machines.find((candidate) => candidate.id === effectiveSelectedMachineId);
        return machine?.metadata?.displayName || machine?.metadata?.host || machine?.id || null;
    }, [effectiveSelectedMachineId, machines]);
    const selectedMachineHomeDir = React.useMemo(() => {
        const machine = machines.find((candidate) => candidate.id === effectiveSelectedMachineId);
        return machine?.metadata?.homeDir ?? null;
    }, [effectiveSelectedMachineId, machines]);

    React.useEffect(() => {
        linkRequestTokenRef.current += 1;
        linkingSessionIdRef.current = null;
        setLinkingSessionId(null);
    }, [candidateActionAuthorityGeneration]);

    const handleOpenCandidate = React.useCallback(async (
        candidate: ExternalSessionBrowseCandidate,
        selectionAuthorityGeneration: number,
    ) => {
        if (!candidateActionsAllowed) return;
        /**
         * A press captured before the browse scope changed carries the previous
         * scope's machine, Agent and source. Every branch below acts on that
         * captured scope — navigating, picking, or creating a link — so the
         * authority check belongs at entry, not only after the link round trip.
         */
        if (candidateActionAuthorityRef.current.generation !== selectionAuthorityGeneration) return;
        if (!effectiveSelectedMachineId || !selectedProviderId || !selectedSource) return;
        if (linkingSessionIdRef.current !== null) return;
        if (interaction === 'pickRemoteSessionId') {
            props.onPickRemoteSessionId?.(candidate.remoteSessionId);
            return;
        }
        if (candidate.linkedSessionId) {
            router.push(`/session/${candidate.linkedSessionId}` as any);
            return;
        }
        const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
        const requestToken = linkRequestTokenRef.current + 1;
        linkRequestTokenRef.current = requestToken;
        linkingSessionIdRef.current = candidateKey;
        setLinkingSessionId(candidateKey);
        const requestIsCurrent = () => (
            linkRequestTokenRef.current === requestToken
            && candidateActionAuthorityRef.current.generation === selectionAuthorityGeneration
        );
        try {
            const linkEnsureExtras = resolveExternalSessionBrowseLinkEnsureRequestExtras({
                providerId: selectedProviderId,
                source: selectedSource,
                candidate,
            });
            const candidateSource = linkEnsureExtras.source && typeof linkEnsureExtras.source === 'object'
                ? (linkEnsureExtras.source as ExternalSessionsSource)
                : undefined;
            const effectiveSource = resolveExternalSessionBrowseCompatibleLinkSource({
                providerId: selectedProviderId,
                selectedSource,
                candidateSource,
            });
            const request = {
                machineId: effectiveSelectedMachineId,
                agentId: selectedProviderId,
                remoteSessionId: candidate.remoteSessionId,
                ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
                ...(candidate.title ? { titleHint: candidate.title } : {}),
                ...(readExternalSessionBrowseCandidatePath(candidate.details) ? { directoryHint: readExternalSessionBrowseCandidatePath(candidate.details)! } : {}),
                ...linkEnsureExtras,
                source: effectiveSource,
            };
            const result = lockScope?.serverId
                ? await machineExternalSessionLinkEnsure(request, { serverId: lockScope.serverId })
                : await machineExternalSessionLinkEnsure(request);
            if (!requestIsCurrent()) return;
            if (!result.ok) {
                Modal.alert(
                    t('common.error'),
                    resolveExternalSessionBrowseRpcErrorMessage(result.errorCode, 'link'),
                );
                return;
            }
            router.push(`/session/${result.sessionId}` as any);
        } catch (linkError) {
            if (!requestIsCurrent()) return;
            Modal.alert(
                t('common.error'),
                resolveExternalSessionBrowseThrownErrorMessage(linkError, 'link'),
            );
        } finally {
            if (linkRequestTokenRef.current === requestToken) {
                linkingSessionIdRef.current = null;
                setLinkingSessionId(null);
            }
        }
    }, [candidateActionsAllowed, effectiveSelectedMachineId, interaction, lockScope?.serverId, props, router, selectedProviderId, selectedSource]);

    return (
        <PopoverScope boundaryRef={popoverBoundaryRef}>
            <View ref={popoverBoundaryRef} style={styles.root} testID="direct-sessions-browse-modal">
                {!locked ? (
                    <ItemGroup
                        style={styles.filtersGroup}
                        title={t('externalSessions.browseFiltersTitle')}
                        containerStyle={styles.filtersGroupContainer}
                    >
                        {machines.length === 0 ? (
                            <Item
                                title={t('externalSessions.browseNoMachines')}
                                mode="info"
                            />
                        ) : (
                            <>
                                <DropdownMenu
                                    open={machineMenuOpen}
                                    onOpenChange={setMachineMenuOpen}
                                    items={machineMenuItems}
                                    selectedId={effectiveSelectedMachineId}
                                    onSelect={(itemId) => {
                                        setSelectedMachineId(itemId);
                                        setMachineMenuOpen(false);
                                    }}
                                    showCategoryTitles={false}
                                    variant="selectable"
                                    rowKind="item"
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    itemTrigger={{
                                        title: t('externalSessions.browseMachines'),
                                        icon: <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
                                        subtitleFormatter: formatMachineTriggerSubtitle,
                                        showSelectedDetail: false,
                                        itemProps: {
                                            testID: 'direct-session-machine-picker-trigger',
                                        },
                                    }}
                                />
                                <DropdownMenu
                                    open={providerMenuOpen}
                                    onOpenChange={setProviderMenuOpen}
                                    items={providerMenuItems}
                                    selectedId={selectedProviderId}
                                    onSelect={(itemId) => {
                                        setSelectedProviderId(itemId as ExternalSessionBrowseProviderId);
                                        setProviderMenuOpen(false);
                                    }}
                                    showCategoryTitles={false}
                                    variant="selectable"
                                    rowKind="item"
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    itemTrigger={{
                                        title: t('externalSessions.browseAgents'),
                                        icon: <Icon name="cpu" size={16} color={theme.colors.text.secondary} />,
                                        subtitleFormatter: formatSelectedTitleSubtitle,
                                        showSelectedDetail: false,
                                        itemProps: {
                                            testID: 'direct-session-provider-picker-trigger',
                                        },
                                    }}
                                />
                                <DropdownMenu
                                    open={sourceMenuOpen}
                                    onOpenChange={setSourceMenuOpen}
                                    items={sourceMenuItems}
                                    selectedId={selectedSourceKey}
                                    onSelect={(itemId) => {
                                        setSelectedSourceKey(itemId);
                                        setSourceMenuOpen(false);
                                    }}
                                    showCategoryTitles={false}
                                    variant="selectable"
                                    rowKind="item"
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    itemTrigger={{
                                        title: t('externalSessions.browseSources'),
                                        icon: <Icon name="folder-open" size={16} color={theme.colors.text.secondary} />,
                                        subtitleFormatter: formatSelectedTitleSubtitle,
                                        showSelectedDetail: false,
                                        itemProps: {
                                            testID: 'direct-session-source-picker-trigger',
                                        },
                                    }}
                                />
                            </>
                        )}
                    </ItemGroup>
                ) : (
                    <View
                        testID="direct-session-locked-scope-summary"
                        style={styles.lockedScopeSummary}
                    >
                        <SessionContextChips
                            machineLabel={selectedMachineLabel ?? lockScope?.machineId ?? t('externalSessions.browseNoMachines')}
                            pathLabel={[
                                selectedAgentProjection?.title ?? lockScope?.providerId,
                                selectedSourceLabel,
                            ].filter(Boolean).join(' · ')}
                        />
                    </View>
                )}
                {autoLinkPolicyScope ? (
                    <ItemGroup
                        title={t('externalSessions.settingsAutoLinkGroupTitle')}
                        containerStyle={styles.filtersGroupContainer}
                    >
                        <Item
                            testID="external-sessions-browse-auto-link"
                            title={t('externalSessions.browseAutoLinkTitle')}
                            subtitle={t('externalSessions.settingsAutoLinkSubtitle')}
                            loading={autoLinkMutationPending}
                            disabled={autoLinkMutationPending}
                            rightElement={(
                                <Switch
                                    testID="external-sessions-browse-auto-link-toggle"
                                    accessibilityLabel={t('externalSessions.browseAutoLinkTitle')}
                                    accessibilityHint={t('externalSessions.settingsAutoLinkHint')}
                                    value={autoLinkPolicyEnabled}
                                    disabled={autoLinkMutationPending}
                                    onValueChange={(enabled) => {
                                        void setAutoLinkPolicyEnabled(enabled);
                                    }}
                                />
                            )}
                            rightElementOutsidePressable
                            showChevron={false}
                            onPress={() => {
                                void setAutoLinkPolicyEnabled(!autoLinkPolicyEnabled);
                            }}
                        />
                    </ItemGroup>
                ) : null}

                <ExternalSessionBrowseCandidatesList
                    candidates={candidates}
                    loading={loading}
                    error={error}
                    offline={selectedMachineIsOffline}
                    nextCursor={nextCursor}
                    paginationRequestKey={paginationRequestKey}
                    loadingMore={loadingMore}
                    searchAugmenting={searchAugmenting}
                    searchIncomplete={searchIncomplete}
                    annotationsIncomplete={annotationsIncomplete}
                    preparation={preparation}
                    preparationStopped={preparationStopped}
                    cancelled={cancelled}
                    linkingSessionId={linkingSessionId}
                    candidateActionsDisabled={!candidateActionsAllowed}
                    agentId={selectedAgentProjection?.iconAgentId ?? selectedProviderId}
                    agentLabel={selectedAgentProjection?.title ?? null}
                    machineLabel={selectedMachineLabel}
                    machineHomeDir={selectedMachineHomeDir}
                    sourceLabel={selectedSourceLabel}
                    projectionPhase={daemonMergedProjection.phase === 'idle'
                        ? 'ready'
                        : daemonMergedProjection.phase}
                    browseCapabilityAvailable={browseProviderIds.length > 0}
                    searchQuery={searchQuery}
                    onSearchQueryChange={setSearchQuery}
                    selectionAuthorityGeneration={candidateActionAuthorityGeneration}
                    onSelectCandidate={(candidate, selectionAuthorityGeneration) => {
                        void handleOpenCandidate(candidate, selectionAuthorityGeneration);
                    }}
                    onLoadMore={() => { void loadMore(); }}
                    onCancelPreparation={cancelPreparation}
                    onRetry={() => {
                        if (daemonMergedProjection.phase !== 'ready' && effectiveSelectedMachineId) {
                            setDaemonProjectionRefreshKey((current) => current + 1);
                            return;
                        }
                        void (nextCursor ? loadMore() : reload());
                    }}
                    onRequestClose={props.onRequestClose ?? (() => router.back())}
                />
            </View>
        </PopoverScope>
    );
});
