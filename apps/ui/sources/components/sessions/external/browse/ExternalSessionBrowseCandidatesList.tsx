import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListSectionDescriptor,
    type SelectionListStep,
} from '@/components/ui/selectionList';
import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { Theme } from '@/theme';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import {
    buildExternalSessionBrowseCandidateDisplayTitle,
    buildExternalSessionBrowseCandidateRightElement,
    buildExternalSessionBrowseCandidateSubtitle,
    readExternalSessionBrowseCandidatePath,
} from './buildExternalSessionBrowseCandidatePresentation';
import {
    readExternalSessionBrowseCandidateKey,
    type ExternalSessionBrowseCandidate,
    type ExternalSessionBrowsePreparation,
} from './useExternalSessionBrowseCandidates';

type AppTheme = Theme;

const styles = StyleSheet.create((theme: AppTheme) => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
    loading: {
        flex: 1,
        minHeight: 220,
        justifyContent: 'center',
    },
    loadingLabel: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
        paddingBottom: 8,
    },
    loadingProgress: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
        paddingBottom: 12,
    },
    loadingProgressRegion: {
        width: '100%',
    },
    searchProgress: {
        paddingHorizontal: 8,
    },
    searchIncomplete: {
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    loadingAction: {
        alignSelf: 'center',
        marginTop: 12,
    },
}));

function buildCandidateSections(params: Readonly<{
    candidates: readonly ExternalSessionBrowseCandidate[];
    linkingSessionId: string | null;
    theme: AppTheme;
    density: ReturnType<typeof useResolvedItemDensity>;
    agentId?: string | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
}>): ReadonlyArray<SelectionListSectionDescriptor> {
    const candidatesByProject = new Map<string, ExternalSessionBrowseCandidate[]>();
    for (const candidate of params.candidates) {
        const path = readExternalSessionBrowseCandidatePath(candidate.details);
        const groupKey = path ?? '<unknown-project>';
        const group = candidatesByProject.get(groupKey);
        if (group) group.push(candidate);
        else candidatesByProject.set(groupKey, [candidate]);
    }

    return Array.from(candidatesByProject.entries()).map(([path, candidates]) => {
        const options: SelectionListOption[] = candidates.map((candidate) => {
            const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
            const visualSubtitle = buildExternalSessionBrowseCandidateSubtitle(
                candidate,
                params.theme,
                params.density,
                {
                    agentLabel: params.agentLabel,
                    machineLabel: params.machineLabel,
                },
            );
            const searchablePath = readExternalSessionBrowseCandidatePath(candidate.details) ?? '';
            return {
                id: candidateKey,
                testID: `direct-session-candidate:${candidateKey}`,
                label: buildExternalSessionBrowseCandidateDisplayTitle(candidate),
                icon: params.agentId ? (
                    <AgentIcon
                        agentId={params.agentId}
                        size={20}
                        testID={`external-session-candidate-agent:${candidate.remoteSessionId}`}
                    />
                ) : undefined,
                subtitle: searchablePath,
                subtitleContent: visualSubtitle,
                rightAccessory: buildExternalSessionBrowseCandidateRightElement(
                    candidate,
                    params.theme,
                    params.density,
                ),
                disabled: params.linkingSessionId !== null,
                loading: params.linkingSessionId === candidateKey,
            };
        });
        return {
            kind: 'static' as const,
            id: `project:${path}`,
            title: path === '<unknown-project>'
                ? t('externalSessions.browseCandidates')
                : formatPathRelativeToHome(path),
            options,
            virtualization: 'force' as const,
            count: options.length,
            disableSubtitleRanking: false,
        };
    });
}

function BrowseLoadingState(props: Readonly<{
    preparation: ExternalSessionBrowsePreparation | null;
    onCancelPreparation?: () => void;
}>): React.ReactElement {
    const progressLabel = props.preparation?.total === undefined
        ? t('externalSessions.browseIndexing')
        : t('externalSessions.browseIndexingProgress', {
            scanned: props.preparation.scanned,
            total: props.preparation.total,
        });
    return (
        <View style={styles.loading}>
            <View
                testID={props.preparation
                    ? 'direct-session-candidates:indexing'
                    : 'direct-session-candidates:loading'}
                style={styles.loadingProgressRegion}
                accessibilityRole={props.preparation ? 'progressbar' : 'text'}
                accessibilityLabel={props.preparation ? progressLabel : t('common.loading')}
                accessibilityValue={props.preparation?.total === undefined ? undefined : {
                    min: 0,
                    max: props.preparation.total,
                    now: props.preparation.scanned,
                }}
                accessibilityLiveRegion="polite"
                {...({
                    role: props.preparation ? 'progressbar' : 'status',
                    'aria-live': 'polite',
                } as Record<string, unknown>)}
            >
                <Text style={styles.loadingLabel}>
                    {props.preparation ? t('externalSessions.browseIndexing') : t('common.loading')}
                </Text>
                {props.preparation ? (
                    props.preparation.total === undefined ? (
                        <ActivitySpinner size="small" />
                    ) : (
                        <Text style={styles.loadingProgress}>{progressLabel}</Text>
                    )
                ) : (
                    Array.from({ length: 5 }, (_, index) => (
                        <SelectionListSkeletonRow
                            key={index}
                            index={index}
                            testID={`direct-session-candidates:loading:row-${index}`}
                        />
                    ))
                )}
            </View>
            {props.preparation && props.onCancelPreparation ? (
                <RoundButton
                    testID="direct-session-candidates:indexing:cancel"
                    size="small"
                    title={t('common.cancel')}
                    accessibilityLabel={t('common.cancel')}
                    onPress={props.onCancelPreparation}
                    style={styles.loadingAction}
                />
            ) : null}
        </View>
    );
}

export const ExternalSessionBrowseCandidatesList = React.memo(function ExternalSessionBrowseCandidatesList(props: Readonly<{
    candidates: readonly ExternalSessionBrowseCandidate[];
    loading: boolean;
    error: string | null;
    offline?: boolean;
    nextCursor: string | null;
    loadingMore: boolean;
    searchAugmenting: boolean;
    searchIncomplete: boolean;
    preparation: ExternalSessionBrowsePreparation | null;
    linkingSessionId: string | null;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate) => void;
    onLoadMore: () => void;
    onRetry?: () => void;
    onCancelPreparation?: () => void;
    onRequestClose?: () => void;
    agentId?: string | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
    sourceLabel?: string | null;
}>) {
    const { theme } = useUnistyles() as { theme: AppTheme };
    const itemDensity = useResolvedItemDensity(undefined);
    const candidateById = React.useMemo(
        () => new Map(props.candidates.map((candidate) => [
            readExternalSessionBrowseCandidateKey(candidate),
            candidate,
        ] as const)),
        [props.candidates],
    );
    const sections = React.useMemo(
        () => buildCandidateSections({
            candidates: props.candidates,
            linkingSessionId: props.linkingSessionId,
            theme,
            density: itemDensity,
            agentId: props.agentId,
            agentLabel: props.agentLabel,
            machineLabel: props.machineLabel,
        }),
        [itemDensity, props.agentId, props.agentLabel, props.candidates, props.linkingSessionId, props.machineLabel, theme],
    );
    const rootStep = React.useMemo<SelectionListStep>(() => {
        const hasSearchQuery = props.searchQuery.trim().length > 0;
        const emptyStateContext = Array.from(new Set(
            [props.agentLabel, props.sourceLabel]
                .map((label) => label?.trim())
                .filter((label): label is string => Boolean(label)),
        )).join(' · ');
        const emptyStateLabel = t(hasSearchQuery
            ? 'externalSessions.browseNoSearchResults'
            : 'externalSessions.browseNoCandidates');
        return {
            id: 'external-session-candidates',
            inputPlaceholder: t('externalSessions.browseSearchPlaceholder'),
            disableInputFilter: true,
            emptyStateLabel: !hasSearchQuery && emptyStateContext
                ? `${emptyStateLabel}\n${emptyStateContext}`
                : emptyStateLabel,
            sections,
        };
    }, [props.agentLabel, props.searchQuery, props.sourceLabel, sections]);
    const handleSelect = React.useCallback((id: string) => {
        const candidate = candidateById.get(id);
        if (candidate) props.onSelectCandidate(candidate);
    }, [candidateById, props.onSelectCandidate]);

    const hasLoadedRows = props.candidates.length > 0;
    const contentState = !hasLoadedRows && (props.loading || props.loadingMore) ? (
        <BrowseLoadingState
            preparation={props.preparation}
            onCancelPreparation={props.onCancelPreparation}
        />
    ) : !hasLoadedRows && props.error ? (
        <SurfaceStateCard
            testID={`direct-session-candidates:${props.offline ? 'offline' : 'error'}`}
            kind={props.offline ? 'unavailable' : 'error'}
            title={props.offline ? t('newSession.machineOfflineInlineTitle') : t('common.error')}
            reason={props.error}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    ) : !hasLoadedRows && props.nextCursor ? (
        <SurfaceStateCard
            testID="direct-session-candidates:empty-continuation"
            kind="empty"
            title={t(props.searchQuery.trim().length > 0
                ? 'externalSessions.browseNoSearchResults'
                : 'externalSessions.browseNoCandidates')}
            action={{
                label: t('externalSessions.browseLoadMore'),
                onPress: props.onLoadMore,
            }}
        />
    ) : undefined;

    return (
        <View style={styles.root}>
            {props.searchIncomplete && props.candidates.length > 0 ? (
                <Text
                    testID="direct-session-candidates-search-incomplete"
                    style={styles.searchIncomplete}
                    accessibilityLiveRegion="polite"
                    {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                >
                    {t('externalSessions.browseSearchIncomplete', {
                        count: props.candidates.length,
                    })}
                </Text>
            ) : null}
            <SelectionList
                rootStep={rootStep}
                inputValue={props.searchQuery}
                inputTestID="direct-session-candidates-search-input"
                onChangeInputValue={props.onSearchQueryChange}
                inputSuffix={props.searchAugmenting ? (
                    <View
                        testID="direct-session-candidates-search-augmenting"
                        style={styles.searchProgress}
                        accessibilityLabel={t('common.loading')}
                    >
                        <ActivitySpinner size="small" />
                    </View>
                ) : undefined}
                onSelect={handleSelect}
                onRequestClose={props.onRequestClose ?? (() => undefined)}
                keyboardHintsEnabled={false}
                disableTransitions
                testID="direct-session-candidates"
                fillAvailableSpace
                showsVerticalScrollIndicator
                contentState={contentState}
                pagination={hasLoadedRows ? {
                    hasMore: props.nextCursor !== null,
                    loadingMore: props.loadingMore,
                    requestKey: props.nextCursor,
                    error: props.error,
                    onEndReached: props.onLoadMore,
                    onRetry: props.onRetry,
                    loadingLabel: t('common.loading'),
                    retryLabel: t('common.retry'),
                    endReachedLabel: t('common.done'),
                } : undefined}
            />
        </View>
    );
});
