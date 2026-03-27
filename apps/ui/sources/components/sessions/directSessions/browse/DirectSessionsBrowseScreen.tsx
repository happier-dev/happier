import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { DirectSessionActivityV1, DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAgentCore } from '@/agents/catalog/catalog';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { useAllMachines } from '@/sync/domains/state/storage';
import { machineDirectSessionLinkEnsure, machineDirectSessionsCandidatesList } from '@/sync/ops/machineDirectSessions';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { lightTheme } from '@/theme';
import { t } from '@/text';

import {
    buildDirectBrowseCandidateDisplayTitle,
    buildDirectBrowseCandidateRightElement,
    buildDirectBrowseCandidateSearchValue,
    buildDirectBrowseCandidateSubtitle,
    readDirectBrowseCandidatePath,
} from './buildDirectBrowseCandidatePresentation';
import { getPreferredDirectBrowseProviderId } from './getPreferredDirectBrowseProviderId';
import {
    listDirectBrowseProviderIds,
    resolveDirectBrowseLinkEnsureRequestExtras,
    resolveDirectBrowseSourceOptions,
} from './resolveDirectBrowseSourceOptions';

type DirectBrowseProviderId = DirectSessionsProviderId;
type AppTheme = typeof lightTheme;

export type DirectSessionsBrowseScopeLock = Readonly<{
    machineId: string;
    serverId?: string | null;
    providerId: DirectSessionsProviderId;
    source: DirectSessionsSource;
}>;

export type DirectSessionsBrowseInteraction = 'openSession' | 'pickRemoteSessionId';

type DirectBrowseCandidate = Readonly<{
    remoteSessionId: string;
    title?: string;
    updatedAtMs: number;
    activity?: DirectSessionActivityV1;
    details?: Record<string, unknown>;
}>;

function shouldUseCandidateSource(selectedSource: DirectSessionsSource, candidateSource: DirectSessionsSource | undefined): boolean {
    if (!candidateSource || candidateSource.kind !== selectedSource.kind) return false;
    if (selectedSource.kind === 'codexHome' && candidateSource.kind === 'codexHome') {
        if (selectedSource.home !== candidateSource.home) return false;
        if (selectedSource.home === 'connectedService') {
            return selectedSource.connectedServiceId === candidateSource.connectedServiceId
                && (selectedSource.connectedServiceProfileId ?? '') === (candidateSource.connectedServiceProfileId ?? '');
        }
        return true;
    }
    if (selectedSource.kind === 'claudeConfig' && candidateSource.kind === 'claudeConfig') {
        return (selectedSource.configDir ?? '') === (candidateSource.configDir ?? '')
            && (selectedSource.projectId ?? '') === (candidateSource.projectId ?? '');
    }
    if (selectedSource.kind === 'opencodeServer' && candidateSource.kind === 'opencodeServer') {
        return (selectedSource.baseUrl ?? '') === (candidateSource.baseUrl ?? '')
            && (selectedSource.directory ?? '') === (candidateSource.directory ?? '');
    }
    return false;
}

const CANDIDATES_PAGE_LIMIT = 50;

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
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        shadowOpacity: 0,
        elevation: 0,
        marginHorizontal: 12,
    },
    helperText: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    searchContainer: {
        paddingHorizontal: 12,
        paddingTop: 12,
        paddingBottom: 6,
    },
    searchInput: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHigh,
        color: theme.colors.text,
        fontSize: 13,
    },
    loadingRow: {
        paddingVertical: 18,
        alignItems: 'center',
        justifyContent: 'center',
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
    const router = useRouter();
    const { theme } = useUnistyles() as { theme: AppTheme };
    const itemDensity = useResolvedItemDensity(undefined);
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
    const [candidates, setCandidates] = React.useState<readonly DirectBrowseCandidate[]>([]);
    const [nextCursor, setNextCursor] = React.useState<string | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [loadingMore, setLoadingMore] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [linkingSessionId, setLinkingSessionId] = React.useState<string | null>(null);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [machineMenuOpen, setMachineMenuOpen] = React.useState(false);
    const [providerMenuOpen, setProviderMenuOpen] = React.useState(false);
    const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
    const loadGenerationRef = React.useRef(0);
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
        icon: <Ionicons name="desktop-outline" size={18} color={theme.colors.textSecondary} />,
    })), [machines, theme.colors.textSecondary]);
    const providerMenuItems = React.useMemo(() => providers.map((provider) => ({
        id: provider.id,
        title: provider.label,
        icon: <Ionicons name="hardware-chip-outline" size={18} color={theme.colors.textSecondary} />,
    })), [providers, theme.colors.textSecondary]);
    const sourceMenuItems = React.useMemo(() => sourceOptions.map((sourceOption) => ({
        id: sourceOption.key,
        title: sourceOption.label,
        subtitle: sourceOption.detail,
        icon: <Ionicons name="folder-open-outline" size={18} color={theme.colors.textSecondary} />,
    })), [sourceOptions, theme.colors.textSecondary]);
    const formatMachineTriggerSubtitle = React.useCallback((selectedItem: Readonly<{ title: string; subtitle?: React.ReactNode }> | null) => {
        if (!selectedItem) return null;
        const statusLabel = typeof selectedItem.subtitle === 'string' ? selectedItem.subtitle.trim() : '';
        return statusLabel ? `${selectedItem.title} · ${statusLabel}` : selectedItem.title;
    }, []);
    const formatSelectedTitleSubtitle = React.useCallback((selectedItem: Readonly<{ title: string }> | null) => {
        return selectedItem?.title ?? null;
    }, []);

    const loadCandidates = React.useCallback(async (opts?: Readonly<{ cursor?: string | null; append?: boolean }>) => {
        if (!effectiveSelectedMachineId || !selectedProviderId || !selectedSource) return;

        const append = opts?.append === true;
        if (!append) {
            loadGenerationRef.current += 1;
        }
        const currentGeneration = loadGenerationRef.current;

        if (append) {
            setLoadingMore(true);
        } else {
            setLoading(true);
            setError(null);
        }

        try {
            const request = {
                machineId: effectiveSelectedMachineId,
                providerId: selectedProviderId,
                source: selectedSource,
                limit: CANDIDATES_PAGE_LIMIT,
                ...(opts?.cursor ? { cursor: opts.cursor } : {}),
            };
            const result = lockScope?.serverId
                ? await machineDirectSessionsCandidatesList(request, { serverId: lockScope.serverId })
                : await machineDirectSessionsCandidatesList(request);

            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }

            if (!result.ok) {
                setError(result.error);
                if (!append) {
                    setCandidates([]);
                    setNextCursor(null);
                }
                return;
            }

            const nextItems = result.candidates.map((candidate) => ({
                remoteSessionId: candidate.remoteSessionId,
                title: candidate.title,
                updatedAtMs: candidate.updatedAtMs,
                activity: candidate.activity,
                details: candidate.details,
            })) satisfies readonly DirectBrowseCandidate[];

            setCandidates((current) => append ? [...current, ...nextItems] : nextItems);
            setNextCursor(result.nextCursor ?? null);
            setError(null);
        } catch (loadError) {
            if (loadGenerationRef.current !== currentGeneration) {
                return;
            }
            const message = loadError instanceof Error ? loadError.message : t('directSessions.browseFailedToLoad');
            setError(message);
            if (!append) {
                setCandidates([]);
                setNextCursor(null);
            }
        } finally {
            if (loadGenerationRef.current === currentGeneration) {
                if (append) {
                    setLoadingMore(false);
                } else {
                    setLoading(false);
                }
            }
        }
    }, [effectiveSelectedMachineId, lockScope?.serverId, selectedProviderId, selectedSource]);

    React.useEffect(() => {
        void loadCandidates();
    }, [loadCandidates]);

    const filteredCandidates = React.useMemo(() => {
        const normalizedSearchQuery = searchQuery.trim().toLowerCase();
        if (!normalizedSearchQuery) return candidates;
        return candidates.filter((candidate) => buildDirectBrowseCandidateSearchValue(candidate).includes(normalizedSearchQuery));
    }, [candidates, searchQuery]);

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
            router.push(`/session/${result.sessionId}` as any);
        } catch (linkError) {
            Modal.alert(t('common.error'), linkError instanceof Error ? linkError.message : t('directSessions.browseLinkFailed'));
        } finally {
            setLinkingSessionId(null);
        }
    }, [effectiveSelectedMachineId, interaction, lockScope?.serverId, props, router, selectedProviderId, selectedSource]);

    const handleLoadMore = React.useCallback(async () => {
        if (!nextCursor || loadingMore) return;
        await loadCandidates({ cursor: nextCursor, append: true });
    }, [loadCandidates, loadingMore, nextCursor]);

    return (
        <ItemList style={styles.list} testID="direct-sessions-browse-modal">
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
                            itemTrigger={{
                                title: t('directSessions.browseMachines'),
                                icon: <Ionicons name="desktop-outline" size={18} color={theme.colors.textSecondary} />,
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
                            itemTrigger={{
                                title: t('directSessions.browseProviders'),
                                icon: <Ionicons name="hardware-chip-outline" size={18} color={theme.colors.textSecondary} />,
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
                            itemTrigger={{
                                title: t('directSessions.browseSources'),
                                icon: <Ionicons name="folder-open-outline" size={18} color={theme.colors.textSecondary} />,
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

            <ItemGroup title={t('directSessions.browseCandidates')}>
                <View style={styles.searchContainer}>
                    <TextInput
                        testID="direct-session-candidates-search-input"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                        placeholder={t('directSessions.browseSearchPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        style={styles.searchInput}
                    />
                </View>
                {loading ? (
                    <View style={styles.loadingRow}>
                        <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                    </View>
                ) : error ? (
                    <View>
                        <Text style={styles.helperText}>{error}</Text>
                    </View>
                ) : candidates.length === 0 ? (
                    <View>
                        <Text style={styles.helperText}>{t('directSessions.browseNoCandidates')}</Text>
                    </View>
                ) : filteredCandidates.length === 0 ? (
                    <View>
                        <Text style={styles.helperText}>{t('directSessions.browseNoSearchResults')}</Text>
                    </View>
                ) : (
                    <>
                        {filteredCandidates.map((candidate) => (
                            <Item
                                key={candidate.remoteSessionId}
                                testID={`direct-session-candidate:${candidate.remoteSessionId}`}
                                title={buildDirectBrowseCandidateDisplayTitle(candidate)}
                                subtitle={buildDirectBrowseCandidateSubtitle(candidate, theme, itemDensity)}
                                rightElement={buildDirectBrowseCandidateRightElement(candidate, theme, itemDensity)}
                                onPress={() => { void handleOpenCandidate(candidate); }}
                                loading={linkingSessionId === candidate.remoteSessionId}
                            />
                        ))}
                        {nextCursor ? (
                            <Item
                                testID="direct-session-candidates-load-more"
                                title={t('directSessions.browseLoadMore')}
                                onPress={() => { void handleLoadMore(); }}
                                loading={loadingMore}
                            />
                        ) : null}
                    </>
                )}
            </ItemGroup>
        </ItemList>
    );
});
