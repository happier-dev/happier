import * as React from 'react';
import { AccessibilityInfo, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import {
    resolveExternalSessionBrowseCandidateIdentityPresentation,
} from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import {
    resolveExternalSessionCandidateActivityPresentation,
    resolveExternalSessionStatusPillState,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import { resolveOverlayPointerEvents } from '@/components/ui/overlays/resolveOverlayPointerEvents';
import {
    SelectionList,
    type SelectionListOption,
    type SelectionListStep,
    type SelectionListVirtualizedOptionSource,
    type SelectionListVirtualizedOptionSourceItem,
} from '@/components/ui/selectionList';
import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    resolveStatusPillVariantForState,
    StatusPill,
} from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
    readExternalSessionBrowseCandidateKey,
    readExternalSessionBrowseCandidatePath,
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
    indexingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    indexingBannerRegion: {
        flex: 1,
        minWidth: 0,
    },
    indexingBannerLabel: {
        color: theme.colors.text.secondary,
        textAlign: 'left',
    },
    indexingBannerProgress: {
        color: theme.colors.text.tertiary,
        textAlign: 'left',
    },
    indexingBannerAction: {
        marginTop: 0,
    },
    accessibilityStatus: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
}));

function useIosAccessibilityAnnouncement(message: string | null): void {
    const lastAnnouncementRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') return;
        if (!message) {
            lastAnnouncementRef.current = null;
            return;
        }
        if (lastAnnouncementRef.current === message) return;
        lastAnnouncementRef.current = message;
        try {
            AccessibilityInfo.announceForAccessibility(message);
        } catch {
            // Accessibility announcements are best effort on native platforms.
        }
    }, [message]);
}

function BrowseIndexingAccessibilityStatus(props: Readonly<{
    announcement: string | null;
}>): React.ReactElement | null {
    const pointerEvents = resolveOverlayPointerEvents('none');

    if (Platform.OS === 'ios' || !props.announcement) return null;

    return (
        <View
            testID="direct-session-candidates:indexing:a11y-status"
            accessible
            accessibilityLiveRegion="polite"
            pointerEvents={pointerEvents.nativePointerEvents}
            style={[styles.accessibilityStatus, pointerEvents.webStyle]}
            {...({
                role: 'status',
                'aria-live': 'polite',
                'aria-atomic': true,
            } as Record<string, unknown>)}
        >
            <Text>{props.announcement}</Text>
        </View>
    );
}

type BrowseCandidatePresentationContext = Readonly<{
    theme: AppTheme;
    density: ReturnType<typeof useResolvedItemDensity>;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
}>;

function resolveBrowseCandidateIdentity(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
) {
    return resolveExternalSessionBrowseCandidateIdentityPresentation({
        remoteSessionId: candidate.remoteSessionId,
        title: candidate.title,
        path: candidatePath,
        homeDir: context.machineHomeDir,
        agentLabel: context.agentLabel,
        machineLabel: context.machineLabel,
    });
}

function resolveBrowseCandidateMatchingLabel(candidate: ExternalSessionBrowseCandidate): string {
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    return title || candidate.remoteSessionId;
}

function resolveBrowseCandidateAccessibilityLabel(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
): string {
    const identity = resolveBrowseCandidateIdentity(context, candidate, candidatePath);
    const updatedAtMs = candidate.updatedAtMs;
    const relativeTime = updatedAtMs > 0 ? formatShortRelativeTime(updatedAtMs) : '';
    const activity = candidate.activity;
    const activityPresentation = activity === undefined
        ? null
        : resolveExternalSessionCandidateActivityPresentation(activity);
    return Array.from(new Set([
        identity.title,
        identity.secondaryLabel,
        relativeTime || null,
        activityPresentation ? t(activityPresentation.labelKey) : null,
        candidate.linkedSessionId ? t('externalSessions.browseLinked') : null,
        candidate.imported ? t('externalSessions.browseImported') : null,
    ].filter((label): label is string => Boolean(label?.trim())))).join(', ');
}

function renderBrowseCandidateSubtitle(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
): React.ReactElement {
    const identity = resolveBrowseCandidateIdentity(context, candidate, candidatePath);
    const updatedAtMs = candidate.updatedAtMs;
    const relativeTime = updatedAtMs > 0 ? formatShortRelativeTime(updatedAtMs) : '';
    const subtitleMetrics = ITEM_SUBTITLE_TEXT_METRICS[context.density];
    const subtitleTextStyle = {
        ...Typography.default('regular'),
        ...subtitleMetrics,
    } as const;
    return (
        <Text style={subtitleTextStyle} numberOfLines={1}>
            {relativeTime ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        { color: context.theme.colors.text.secondary },
                    ]}
                >
                    {relativeTime}
                </Text>
            ) : null}
            {relativeTime && identity.secondaryLabel ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        { color: context.theme.colors.text.secondary },
                    ]}
                >
                    {' · '}
                </Text>
            ) : null}
            {identity.secondaryLabel ? (
                <Text
                    style={[
                        subtitleTextStyle,
                        { color: context.theme.colors.text.tertiary },
                    ]}
                >
                    {identity.secondaryLabel}
                </Text>
            ) : null}
        </Text>
    );
}

function renderBrowseCandidateRightAccessory(
    candidate: ExternalSessionBrowseCandidate,
): React.ReactElement | null {
    const activity = candidate.activity;
    if (activity === undefined && !candidate.linkedSessionId && !candidate.imported) return null;
    const activityPresentation = activity === undefined
        ? null
        : resolveExternalSessionCandidateActivityPresentation(activity);
    return (
        <View
            style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
            }}
        >
            {activityPresentation ? (
                <StatusPill
                    variant={resolveStatusPillVariantForState(
                        resolveExternalSessionStatusPillState(activityPresentation),
                    )}
                    label={t(activityPresentation.labelKey)}
                    isPulsing={activityPresentation.indicator === 'working'}
                    testID={`external-session-candidate-status:${candidate.remoteSessionId}`}
                />
            ) : null}
            {candidate.linkedSessionId ? (
                <StatusPill
                    variant="neutral"
                    label={t('externalSessions.browseLinked')}
                    hideDot
                    testID={`external-session-candidate-linked:${candidate.remoteSessionId}`}
                />
            ) : null}
            {candidate.imported ? (
                <StatusPill
                    variant="info"
                    label={t('externalSessions.browseImported')}
                    hideDot
                    testID={`external-session-candidate-imported:${candidate.remoteSessionId}`}
                />
            ) : null}
        </View>
    );
}

const UNKNOWN_PROJECT_KEY = '<unknown-project>';

type BrowseCandidateProjectGroup = {
    path: string;
    candidateIndexes: number[];
};

function buildCandidateVirtualizedSource(params: Readonly<{
    candidates: readonly ExternalSessionBrowseCandidate[];
    getInteractionState: () => Readonly<{
        candidateActionsDisabled: boolean;
        linkingSessionId: string | null;
    }>;
    theme: AppTheme;
    density: ReturnType<typeof useResolvedItemDensity>;
    agentId?: string | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
    selectionAuthorityGeneration: number;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => void;
}>): SelectionListVirtualizedOptionSource {
    const presentationContext: BrowseCandidatePresentationContext = {
        theme: params.theme,
        density: params.density,
        agentLabel: params.agentLabel,
        machineLabel: params.machineLabel,
        machineHomeDir: params.machineHomeDir,
    };
    const groups: BrowseCandidateProjectGroup[] = [];
    const projectGroupIndexByPath = new Map<string, number>();
    const candidatePaths: Array<string | null> = new Array(params.candidates.length);
    for (let candidateIndex = 0; candidateIndex < params.candidates.length; candidateIndex += 1) {
        const candidate = params.candidates[candidateIndex]!;
        const path = readExternalSessionBrowseCandidatePath(candidate.details);
        candidatePaths[candidateIndex] = path;
        const groupKey = path ?? UNKNOWN_PROJECT_KEY;
        const existingGroupIndex = projectGroupIndexByPath.get(groupKey);
        if (existingGroupIndex !== undefined) {
            groups[existingGroupIndex]!.candidateIndexes.push(candidateIndex);
            continue;
        }
        projectGroupIndexByPath.set(groupKey, groups.length);
        groups.push({ path: groupKey, candidateIndexes: [candidateIndex] });
    }
    const items: SelectionListVirtualizedOptionSourceItem[] = [];
    const navigationOptionIndexes: number[] = [];
    let positionInSet = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        items.push({ kind: 'section-header', sectionIndex: groupIndex });
        for (const candidateIndex of groups[groupIndex]!.candidateIndexes) {
            positionInSet += 1;
            navigationOptionIndexes.push(candidateIndex);
            items.push({ kind: 'option', optionIndex: candidateIndex, positionInSet });
        }
    }

    const getCandidate = (candidateIndex: number): ExternalSessionBrowseCandidate => {
        const candidate = params.candidates[candidateIndex];
        if (!candidate) throw new Error('External-session candidate source index is out of bounds');
        return candidate;
    };
    const getOptionId = (candidateIndex: number): string => (
        readExternalSessionBrowseCandidateKey(getCandidate(candidateIndex))
    );
    const isFocusableOptionIndex = (candidateIndex: number): boolean => {
        const interaction = params.getInteractionState();
        return !interaction.candidateActionsDisabled
            && candidateIndex >= 0
            && candidateIndex < params.candidates.length
            && getOptionId(candidateIndex) !== interaction.linkingSessionId;
    };

    return {
        items,
        optionCount: params.candidates.length,
        get stateKey(): string {
            const interaction = params.getInteractionState();
            return `${interaction.candidateActionsDisabled ? 'disabled' : 'enabled'}\u0000${interaction.linkingSessionId ?? ''}`;
        },
        getOption: (candidateIndex: number): SelectionListOption => {
            const candidate = getCandidate(candidateIndex);
            const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
            const candidatePath = candidatePaths[candidateIndex] ?? null;
            const interaction = params.getInteractionState();
            const isPending = candidateKey === interaction.linkingSessionId;
            const agentId = params.agentId;
            return {
                id: candidateKey,
                testID: `direct-session-candidate:${candidateKey}`,
                // Browse owns server-side search, so this stays a cheap
                // synchronous matching fallback while the visible title is
                // resolved only by the mounted SelectionList row.
                label: resolveBrowseCandidateMatchingLabel(candidate),
                renderLabel: () => resolveBrowseCandidateIdentity(
                    presentationContext,
                    candidate,
                    candidatePath,
                ).title,
                renderAccessibilityLabel: () => resolveBrowseCandidateAccessibilityLabel(
                    presentationContext,
                    candidate,
                    candidatePath,
                ),
                icon: agentId ? () => (
                    <AgentIcon
                        agentId={agentId}
                        size={20}
                        testID={`external-session-candidate-agent:${candidate.remoteSessionId}`}
                    />
                ) : undefined,
                subtitle: candidatePath ?? '',
                subtitleContent: () => renderBrowseCandidateSubtitle(
                    presentationContext,
                    candidate,
                    candidatePath,
                ),
                rightAccessory: () => renderBrowseCandidateRightAccessory(candidate),
                onSelect: () => params.onSelectCandidate(candidate, params.selectionAuthorityGeneration),
                disabled: interaction.candidateActionsDisabled || isPending,
                loading: isPending,
            };
        },
        getOptionId,
        findOptionIndexById: (optionId: string): number => {
            for (const candidateIndex of navigationOptionIndexes) {
                if (getOptionId(candidateIndex) === optionId) return candidateIndex;
            }
            return -1;
        },
        getFirstFocusableOptionIndex: (): number => {
            if (params.getInteractionState().candidateActionsDisabled) return -1;
            for (const candidateIndex of navigationOptionIndexes) {
                if (isFocusableOptionIndex(candidateIndex)) return candidateIndex;
            }
            return -1;
        },
        getNextFocusableOptionIndex: (currentCandidateIndex: number, direction: -1 | 1): number => {
            if (params.getInteractionState().candidateActionsDisabled || navigationOptionIndexes.length === 0) return -1;
            const currentNavigationIndex = navigationOptionIndexes.indexOf(currentCandidateIndex);
            let navigationIndex = currentNavigationIndex >= 0
                ? currentNavigationIndex
                : direction === 1 ? -1 : 0;
            for (let checked = 0; checked < navigationOptionIndexes.length; checked += 1) {
                navigationIndex = (navigationIndex + direction + navigationOptionIndexes.length)
                    % navigationOptionIndexes.length;
                const candidateIndex = navigationOptionIndexes[navigationIndex]!;
                if (isFocusableOptionIndex(candidateIndex)) return candidateIndex;
            }
            return -1;
        },
        isFocusableOptionIndex,
        getHeader: (groupIndex: number) => {
            const group = groups[groupIndex];
            if (!group) throw new Error('External-session candidate source section is out of bounds');
            return {
                id: `project:${group.path}`,
                title: group.path === UNKNOWN_PROJECT_KEY
                    ? t('externalSessions.browseCandidates')
                    : formatPathRelativeToHome(group.path, params.machineHomeDir ?? undefined),
                count: group.candidateIndexes.length,
            };
        },
    };
}

function BrowseLoadingState(props: Readonly<{
    preparation: ExternalSessionBrowsePreparation | null;
    onCancelPreparation?: () => void;
    /**
     * Where this one indexing presentation sits. `content` fills the empty list area
     * before the index has served anything; `banner` sits above the rows it has
     * already served, so preparation progress and its cancel affordance stay
     * reachable for the whole build. The two placements are mutually exclusive —
     * `content` only renders while there are no rows — so the progress region and the
     * cancel button never appear twice at once.
     */
    placement?: 'content' | 'banner';
}>): React.ReactElement {
    const isBanner = props.placement === 'banner';
    const progressLabel = props.preparation?.total === undefined
        ? t('externalSessions.browseIndexing')
        : t('externalSessions.browseIndexingProgress', {
            scanned: props.preparation.scanned,
            total: props.preparation.total,
        });
    return (
        <View style={isBanner ? styles.indexingBanner : styles.loading}>
            <View
                testID={props.preparation
                    ? 'direct-session-candidates:indexing'
                    : 'direct-session-candidates:loading'}
                style={isBanner ? styles.indexingBannerRegion : styles.loadingProgressRegion}
                accessibilityRole={props.preparation ? 'progressbar' : 'text'}
                accessibilityLabel={props.preparation ? progressLabel : t('common.loading')}
                accessibilityValue={props.preparation?.total === undefined ? undefined : {
                    min: 0,
                    max: props.preparation.total,
                    now: props.preparation.scanned,
                }}
                accessibilityLiveRegion={props.preparation ? undefined : 'polite'}
                {...({
                    role: props.preparation ? 'progressbar' : 'status',
                    ...(props.preparation ? {} : { 'aria-live': 'polite' }),
                } as Record<string, unknown>)}
            >
                <Text style={isBanner ? styles.indexingBannerLabel : styles.loadingLabel}>
                    {props.preparation ? t('externalSessions.browseIndexing') : t('common.loading')}
                </Text>
                {props.preparation ? (
                    props.preparation.total === undefined ? (
                        <View
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            {...({ 'aria-hidden': true } as Record<string, unknown>)}
                        >
                            <ActivitySpinner size="small" />
                        </View>
                    ) : (
                        <Text style={isBanner ? styles.indexingBannerProgress : styles.loadingProgress}>
                            {progressLabel}
                        </Text>
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
                    style={isBanner ? styles.indexingBannerAction : styles.loadingAction}
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
    paginationRequestKey: string | null;
    loadingMore: boolean;
    searchAugmenting: boolean;
    searchIncomplete: boolean;
    annotationsIncomplete: boolean;
    preparation: ExternalSessionBrowsePreparation | null;
    preparationStopped?: boolean;
    cancelled?: boolean;
    linkingSessionId: string | null;
    candidateActionsDisabled?: boolean;
    searchQuery: string;
    onSearchQueryChange: (query: string) => void;
    selectionAuthorityGeneration: number;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => void;
    onLoadMore: () => void;
    onRetry?: () => void;
    onCancelPreparation?: () => void;
    onRequestClose?: () => void;
    agentId?: string | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
    sourceLabel?: string | null;
    projectionPhase?: 'loading' | 'ready' | 'unsupported' | 'error';
    browseCapabilityAvailable?: boolean;
}>) {
    const { theme } = useUnistyles() as { theme: AppTheme };
    const itemDensity = useResolvedItemDensity(undefined);
    const onSelectCandidateRef = React.useRef(props.onSelectCandidate);
    onSelectCandidateRef.current = props.onSelectCandidate;
    const handleSelectCandidate = React.useCallback(
        (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => {
            onSelectCandidateRef.current(candidate, selectionAuthorityGeneration);
        },
        [],
    );
    const candidateActionsDisabled = props.candidateActionsDisabled === true;
    const interactionStateRef = React.useRef({
        candidateActionsDisabled,
        linkingSessionId: props.linkingSessionId,
    });
    interactionStateRef.current = {
        candidateActionsDisabled,
        linkingSessionId: props.linkingSessionId,
    };
    const getInteractionState = React.useCallback(() => interactionStateRef.current, []);
    const virtualizedOptionSource = React.useMemo(
        () => props.candidates.length === 0 ? null : buildCandidateVirtualizedSource({
            candidates: props.candidates,
            getInteractionState,
            theme,
            density: itemDensity,
            agentId: props.agentId,
            agentLabel: props.agentLabel,
            machineLabel: props.machineLabel,
            machineHomeDir: props.machineHomeDir,
            selectionAuthorityGeneration: props.selectionAuthorityGeneration,
            onSelectCandidate: handleSelectCandidate,
        }),
        [
            getInteractionState,
            handleSelectCandidate,
            itemDensity,
            props.agentId,
            props.agentLabel,
            props.candidates,
            props.machineHomeDir,
            props.machineLabel,
            props.selectionAuthorityGeneration,
            theme,
        ],
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
            sections: [],
            ...(virtualizedOptionSource === null ? {} : { virtualizedOptionSource }),
        };
    }, [props.agentLabel, props.searchQuery, props.sourceLabel, virtualizedOptionSource]);
    const handleSelect = React.useCallback(() => undefined, []);
    const searchIncompleteAnnouncement = props.searchIncomplete && props.candidates.length > 0
        ? t('externalSessions.browseSearchIncomplete', {
            count: props.candidates.length,
        })
        : null;
    const annotationsIncompleteAnnouncement = props.annotationsIncomplete && props.candidates.length > 0
        ? t('externalSessions.browseAnnotationsIncomplete')
        : null;
    const incompleteAnnouncement = [searchIncompleteAnnouncement, annotationsIncompleteAnnouncement]
        .filter((announcement): announcement is string => announcement !== null)
        .join(' ') || null;
    useIosAccessibilityAnnouncement(incompleteAnnouncement);

    const hasLoadedRows = props.candidates.length > 0;
    /**
     * Once the preparing index serves rows, the full-height loading state stands down
     * and this banner takes over the same progress region and the same cancel
     * affordance, so a multi-thousand-round-trip build stays explained and stoppable
     * instead of silently continuing behind the rows it has published.
     */
    const indexingBannerVisible = hasLoadedRows && props.preparation !== null;
    const projectionPhase = props.projectionPhase ?? 'ready';
    const projectionFailureMessage = projectionPhase === 'unsupported' || projectionPhase === 'error'
        ? t('newSession.daemonRpcUnavailableBody')
        : null;
    const loadingAnnouncement = props.preparation
        ? t('externalSessions.browseIndexing')
        : !hasLoadedRows && (projectionPhase === 'loading' || props.loading || props.loadingMore)
            ? t('common.loading')
            : null;
    useIosAccessibilityAnnouncement(loadingAnnouncement);
    /**
     * An index build that stopped before completing leaves a prefix of the source on
     * screen, not the whole of it. The rows stay live, so this rides the pagination
     * status the list already owns: it replaces the end-of-list marker that would
     * otherwise claim the listing is finished, and carries the same retry that
     * restarts the build.
     */
    const stoppedIndexNotice = props.preparationStopped === true && hasLoadedRows
        ? t('externalSessions.browseIndexingCancelled')
        : null;
    const presentationError = props.offline
        ? t('newSession.machineOfflineInlineBody')
        : props.error;
    const retainedRowsLoading = hasLoadedRows
        && (props.loading || projectionPhase === 'loading');
    const contentState = !hasLoadedRows && projectionPhase === 'loading' ? (
        <BrowseLoadingState preparation={null} />
    ) : !hasLoadedRows && (projectionPhase === 'unsupported' || projectionPhase === 'error') ? (
        <SurfaceStateCard
            testID={projectionPhase === 'unsupported'
                ? 'direct-session-candidates:unavailable'
                : 'direct-session-candidates:projection-error'}
            kind={projectionPhase === 'unsupported' ? 'unavailable' : 'error'}
            accessibilitySemantics="alert"
            title={t('newSession.daemonRpcUnavailableTitle')}
            reason={t('newSession.daemonRpcUnavailableBody')}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    ) : !hasLoadedRows && props.browseCapabilityAvailable === false ? (
        <SurfaceStateCard
            testID="direct-session-candidates:no-agents"
            kind="unavailable"
            title={t('externalSessions.settingsIntegrationsUnavailableTitle')}
            reason={t('externalSessions.settingsIntegrationsUnavailableSubtitle')}
        />
    ) : !hasLoadedRows && (props.loading || props.loadingMore) ? (
        <BrowseLoadingState
            preparation={props.preparation}
            onCancelPreparation={props.onCancelPreparation}
        />
    ) : !hasLoadedRows && props.cancelled ? (
        <SurfaceStateCard
            testID="direct-session-candidates:cancelled"
            kind="unavailable"
            accessibilitySemantics="status"
            title={t('externalSessions.browseIndexingCancelled')}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    ) : !hasLoadedRows && props.error && props.nextCursor === null ? (
        <SurfaceStateCard
            testID={`direct-session-candidates:${props.offline ? 'offline' : 'error'}`}
            kind={props.offline ? 'unavailable' : 'error'}
            accessibilitySemantics="alert"
            title={props.offline ? t('newSession.machineOfflineInlineTitle') : t('common.error')}
            reason={presentationError ?? undefined}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    ) : undefined;

    return (
        <View style={styles.root}>
            <BrowseIndexingAccessibilityStatus
                announcement={props.preparation ? loadingAnnouncement : null}
            />
            {indexingBannerVisible ? (
                <BrowseLoadingState
                    placement="banner"
                    preparation={props.preparation}
                    onCancelPreparation={props.onCancelPreparation}
                />
            ) : null}
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
            {props.annotationsIncomplete && props.candidates.length > 0 ? (
                <Text
                    testID="direct-session-candidates-annotations-incomplete"
                    style={styles.searchIncomplete}
                    accessibilityLiveRegion="polite"
                    {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                >
                    {t('externalSessions.browseAnnotationsIncomplete')}
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
                    >
                        <ActivitySpinner
                            size="small"
                            accessibilityLabel={t('common.loading')}
                        />
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
                pagination={hasLoadedRows || props.nextCursor !== null ? {
                    hasMore: props.nextCursor !== null,
                    loadingMore: props.loadingMore || retainedRowsLoading,
                    requestKey: props.paginationRequestKey,
                    error: props.error ?? projectionFailureMessage ?? stoppedIndexNotice,
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
