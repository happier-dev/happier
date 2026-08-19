import * as React from 'react';
import type { ScrollView } from 'react-native';
import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAgentCore } from '@/agents/catalog/catalog';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PopoverScope } from '@/components/ui/popover';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { machineDirectSessionLinkEnsure } from '@/sync/ops/machineDirectSessions';
import { useProfile, useSettings } from '@/sync/store/hooks';
import type { Theme } from '@/theme';
import { t } from '@/text';

import { readDirectBrowseCandidatePath } from './buildDirectBrowseCandidatePresentation';
import { getPreferredDirectBrowseProviderId } from './getPreferredDirectBrowseProviderId';
import {
    listDirectBrowseProviderIds,
    resolveDirectBrowseLinkEnsureRequestExtras,
    resolveDirectBrowseSourceOptions,
} from './resolveDirectBrowseSourceOptions';
import { DirectBrowseCandidatesList } from './DirectBrowseCandidatesList';
import { shouldUseCandidateSource } from './shouldUseCandidateSource';
import { useDirectBrowseCandidates, type DirectBrowseCandidate } from './useDirectBrowseCandidates';
import { Icon } from '@/components/ui/icons/Icon';

type DirectBrowseProviderId = DirectSessionsProviderId;
type AppTheme = Theme;

const DIRECT_BROWSE_SEARCH_DEBOUNCE_MS = 250;

export type DirectSessionsBrowseScopeLock = Readonly<{
    machineId: string;
    serverId?: string | null;
    providerId: DirectSessionsProviderId;
    source: DirectSessionsSource;
}>;

export type DirectSessionsBrowseInteraction = 'openSession' | 'pickRemoteSessionId';

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
    list: {
        paddingTop: 0,
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
}));

export const DirectSessionsBrowseScreen = React.memo((props: Readonly<{
    interaction?: DirectSessionsBrowseInteraction;
    lockScope?: DirectSessionsBrowseScopeLock | null;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
}>) => {
    const interaction: DirectSessionsBrowseInteraction = props.interaction ?? 'openSession';
    const lockScope = props.lockScope ?? null;
    const locked = Boolean(lockScope);
    const navigateToSession = useNavigateToSession();
    const { theme } = useUnistyles() as { theme: AppTheme };
    const styles = stylesheet;
    const machines = useAllMachines();
    const profile = useProfile();
    const settings = useSettings();
    const providers = React.useMemo<ReadonlyArray<Readonly<{ id: DirectBrowseProviderId; label: string }>>>(
        () => listDirectBrowseProviderIds().map((providerId) => ({
            id: providerId,
            label: t(getAgentCore(providerId).displayNameKey),
        })),
        [],
    );
    const providerIds = React.useMemo<readonly DirectBrowseProviderId[]>(() => providers.map((provider) => provider.id), [providers]);
    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => (
        lockScope?.machineId ?? getPreferredMachineId(machines, null)
    ));
    const [selectedProviderId, setSelectedProviderId] = React.useState<DirectBrowseProviderId | null>(() => (
        lockScope?.providerId ?? getPreferredDirectBrowseProviderId(providerIds, null)
    ));
    const sourceOptions = React.useMemo(() => {
        if (lockScope) {
            return [{
                key: 'locked',
                label: t('directSessions.browseSources'),
                source: lockScope.source,
            }];
        }
        if (!selectedProviderId) return [];
        return resolveDirectBrowseSourceOptions({
            providerId: selectedProviderId,
            profile,
            settings,
        });
    }, [lockScope, profile, selectedProviderId, settings]);
    const [selectedSourceKey, setSelectedSourceKey] = React.useState<string | null>(() => (
        lockScope ? 'locked' : sourceOptions[0]?.key ?? null
    ));
    const [linkingSessionId, setLinkingSessionId] = React.useState<string | null>(null);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [candidateSearchTerm, setCandidateSearchTerm] = React.useState('');
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [providerMenuOpen, setProviderMenuOpen] = React.useState(false);
    const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
    const popoverBoundaryRef = React.useRef<ScrollView>(null);
    const effectiveSelectedMachineId = React.useMemo(() => {
        if (lockScope) return lockScope.machineId;
        return getPreferredMachineId(machines, selectedMachineId);
    }, [lockScope, machines, selectedMachineId]);

    React.useEffect(() => {
        if (lockScope) return;
        if (effectiveSelectedMachineId && effectiveSelectedMachineId !== selectedMachineId) {
            setSelectedMachineId(effectiveSelectedMachineId);
        }
    }, [effectiveSelectedMachineId, lockScope, selectedMachineId]);

    React.useEffect(() => {
        if (lockScope) return;
        const preferredProviderId = getPreferredDirectBrowseProviderId(providerIds, selectedProviderId);
        if (preferredProviderId !== selectedProviderId) {
            setSelectedProviderId(preferredProviderId);
        }
    }, [lockScope, providerIds, selectedProviderId]);

    React.useEffect(() => {
        const normalizedSearchQuery = searchQuery.trim();
        if (!normalizedSearchQuery) {
            setCandidateSearchTerm('');
            return;
        }

        const timeout = setTimeout(() => {
            setCandidateSearchTerm(normalizedSearchQuery);
        }, DIRECT_BROWSE_SEARCH_DEBOUNCE_MS);

        return () => {
            clearTimeout(timeout);
        };
    }, [searchQuery]);

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
    const machineMenuItems = React.useMemo(() => machines.map((machine) => ({
        id: machine.id,
        title: machine.metadata?.displayName || machine.metadata?.host || machine.id,
        subtitle: machine.active ? t('status.activeNow') : t('status.offline'),
        icon: <Icon name="desktop" size={16} color={theme.colors.text.secondary} />,
    })), [machines, theme.colors.text.secondary]);
    const providerMenuItems = React.useMemo(() => providers.map((provider) => ({
        id: provider.id,
        title: provider.label,
        icon: <Icon name="cpu" size={16} color={theme.colors.text.secondary} />,
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

    const {
        candidates,
        nextCursor,
        loading,
        loadingMore,
        searchAugmenting,
        error,
        loadMore,
    } = useDirectBrowseCandidates({
        machineId: effectiveSelectedMachineId,
        serverId: lockScope?.serverId ?? null,
        providerId: selectedProviderId,
        source: selectedSource,
        searchTerm: candidateSearchTerm,
    });

    const handleOpenCandidate = React.useCallback(async (candidate: DirectBrowseCandidate) => {
        if (!effectiveSelectedMachineId || !selectedProviderId || !selectedSource) return;
        if (interaction === 'pickRemoteSessionId') {
            props.onPickRemoteSessionId?.(candidate.remoteSessionId);
            return;
        }
        setLinkingSessionId(candidate.remoteSessionId);
        try {
            const linkEnsureExtras = resolveDirectBrowseLinkEnsureRequestExtras({
                providerId: selectedProviderId,
                source: selectedSource,
                candidate,
            });
            const candidateSource = linkEnsureExtras.source && typeof linkEnsureExtras.source === 'object'
                ? (linkEnsureExtras.source as DirectSessionsSource)
                : undefined;
            const effectiveSource: DirectSessionsSource = candidateSource && shouldUseCandidateSource(selectedSource, candidateSource)
                ? candidateSource
                : selectedSource;
            const request = {
                machineId: effectiveSelectedMachineId,
                providerId: selectedProviderId,
                remoteSessionId: candidate.remoteSessionId,
                ...(candidate.title ? { titleHint: candidate.title } : {}),
                ...(readDirectBrowseCandidatePath(candidate.details) ? { directoryHint: readDirectBrowseCandidatePath(candidate.details)! } : {}),
                ...linkEnsureExtras,
                source: effectiveSource,
            };
            const result = lockScope?.serverId
                ? await machineDirectSessionLinkEnsure(request, { serverId: lockScope.serverId })
                : await machineDirectSessionLinkEnsure(request);
            if (!result.ok) {
                Modal.alert(t('common.error'), result.error);
                return;
            }
            await navigateToSession(result.sessionId);
        } catch (linkError) {
            Modal.alert(t('common.error'), linkError instanceof Error ? linkError.message : t('directSessions.browseLinkFailed'));
        } finally {
            setLinkingSessionId(null);
        }
    }, [effectiveSelectedMachineId, interaction, lockScope?.serverId, navigateToSession, props, selectedProviderId, selectedSource]);

    return (
        <PopoverScope boundaryRef={popoverBoundaryRef}>
            <ItemList ref={popoverBoundaryRef} style={styles.list} testID="direct-sessions-browse-modal">
                {!locked ? (
                    <ItemGroup
                        style={styles.filtersGroup}
                        title={t('directSessions.browseFiltersTitle')}
                        containerStyle={styles.filtersGroupContainer}
                    >
                        {machines.length === 0 ? (
                            <Item
                                title={t('directSessions.browseNoMachines')}
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
                                        title: t('directSessions.browseMachines'),
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
                                        setSelectedProviderId(itemId as DirectBrowseProviderId);
                                        setProviderMenuOpen(false);
                                    }}
                                    showCategoryTitles={false}
                                    variant="selectable"
                                    rowKind="item"
                                    matchTriggerWidth={true}
                                    connectToTrigger={true}
                                    popoverBoundaryRef={popoverBoundaryRef}
                                    itemTrigger={{
                                        title: t('directSessions.browseProviders'),
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
                                        title: t('directSessions.browseSources'),
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
                ) : null}

                <DirectBrowseCandidatesList
                    candidates={candidates}
                    loading={loading}
                    error={error}
                    nextCursor={nextCursor}
                    loadingMore={loadingMore}
                    searchAugmenting={searchAugmenting}
                    linkingSessionId={linkingSessionId}
                    searchQuery={searchQuery}
                    onSearchQueryChange={setSearchQuery}
                    onSelectCandidate={(candidate) => { void handleOpenCandidate(candidate); }}
                    onLoadMore={() => { void loadMore(); }}
                />
            </ItemList>
        </PopoverScope>
    );
});
