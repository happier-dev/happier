import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import {
    resolveExternalSessionBrowseCandidateIdentityPresentation,
} from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import {
    resolveExternalSessionCandidateActivityPresentation,
    resolveExternalSessionStatusPillState,
} from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { PoliteAccessibilityStatus } from '@/components/ui/accessibility/PoliteAccessibilityStatus';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ExternalSessionSearchProgress } from './ExternalSessionSearchProgress';
import { resolveBrowseProjectionFailureCopy } from './browseProjectionFailureCopy';
import { ConversationHitStatus, ConversationHitSummary, isConversationHitStatusInMeta, resolveConversationHitSnippet, resolveConversationHitStatusLabel } from './ConversationHitSummary';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { useResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';
import {
    SelectionList,
    type SelectionListFilter,
    type SelectionListOption,
    type SelectionListStep,
    type SelectionListVirtualizedOptionSource,
    type SelectionListVirtualizedOptionSourceItem,
} from '@/components/ui/selectionList';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { SELECTION_LIST_SKELETON_ROW_SHAPE } from '@/components/ui/selectionList/_constants';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import {
    resolveStatusPillVariantForState,
    StatusPill,
} from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import { t } from '@/text';
import type { MachineContributionRegistryProjectionFailureReason } from '@/sync/ops/machineContributionRegistryProjection';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { stripMarkdown } from '@/utils/sessions/messageUtils';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
    readExternalSessionBrowseCandidateKey,
    readExternalSessionBrowseCandidatePath,
    type ExternalSessionBrowseCandidate,
    type ExternalSessionBrowsePreparation,
} from './useExternalSessionBrowseCandidates';
import type { ExternalSessionsBrowseInteraction } from './ExternalSessionsBrowseScreen';
import { isExternalSessionBrowseCandidateOfflineInert } from './resolveExternalSessionBrowseCandidateOfflineInert';

type AppTheme = Theme;

const styles = StyleSheet.create((theme: AppTheme) => ({
    root: {
        flex: 1,
        minHeight: 0,
    },
    loading: {
        flex: 1,
        paddingTop: theme.space.s8,
    },
    loadingProgressRegion: {
        width: '100%',
    },
    searchSuffix: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        flexShrink: 1,
    },
    searchProgress: {
        paddingHorizontal: theme.space.s4,
    },
    // Level with the filter chips' row above it and the field's edge.
    searchTargetRow: {
        paddingHorizontal: theme.space.s8,
        paddingBottom: theme.space.s8,
    },
    searchIncomplete: {
        color: theme.colors.text.secondary,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s8,
    },
    // Indexing: a 2px line across the list's top edge and one status line under it, with Stop at its
    // end. Rows the index has already served stay live below it.
    indexing: {
        width: '100%',
    },
    noMatchesClear: {
        ...Typography.variant('meta'),
        ...Typography.default('medium'),
        color: theme.colors.text.link,
        textDecorationLine: 'underline',
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
        announceAccessibilityMessage(message);
    }, [message]);
}

type BrowseCandidatePresentationContext = Readonly<{
    theme: AppTheme;
    density: ReturnType<typeof useResolvedItemDensity>;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
    /** Titles of the rows in this listing, for naming a thread's parent the Agent did not name. */
    titleByRemoteSessionId?: ReadonlyMap<string, string>;
}>;

type BrowseAgentIdentity = Readonly<{
    entry: ResolvedAgentCatalogEntry;
    machineId: string | null;
    serverId: string | null;
    current: boolean;
}>;

function resolveBrowseCandidateIdentity(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
) {
    const thread = candidate.thread;
    const parentTitle = thread?.parentTitle
        ?? (thread?.parentRemoteSessionId ? context.titleByRemoteSessionId?.get(thread.parentRemoteSessionId) : undefined);
    return resolveExternalSessionBrowseCandidateIdentityPresentation({
        remoteSessionId: candidate.remoteSessionId,
        title: candidate.title,
        path: candidatePath,
        homeDir: context.machineHomeDir,
        agentLabel: context.agentLabel,
        machineLabel: context.machineLabel,
        ...(thread ? { thread: parentTitle ? { ...thread, parentTitle } : thread } : {}),
    });
}

/**
 * What a row shows: the band's chips already name the Agent and the machine for every row, so the
 * visible line keeps only what tells rows apart (thread, project, id hint). Spoken alone, a row still
 * says whose and where (`resolveBrowseCandidateAccessibilityLabel`).
 */
function resolveBrowseCandidateRowIdentity(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
) {
    return resolveBrowseCandidateIdentity({ ...context, agentLabel: null, machineLabel: null }, candidate, candidatePath);
}

/** A hit's where under its project header: the header already names the path, so the line keeps the thread. */
function resolveConversationHitWhere(identity: ReturnType<typeof resolveBrowseCandidateRowIdentity>): string | null {
    return identity.pathLabel ? identity.threadLabel : identity.secondaryLabel;
}

/** The candidate's name without row context (search matching, the delete confirmation): the same owner. */
function resolveBrowseCandidateMatchingLabel(candidate: ExternalSessionBrowseCandidate): string {
    return resolveExternalSessionBrowseCandidateIdentityPresentation({
        remoteSessionId: candidate.remoteSessionId,
        title: candidate.title,
        path: null,
    }).title;
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
        candidate.match ? stripMarkdown(identity.title) : identity.title,
        identity.secondaryLabel,
        relativeTime || null,
        activityPresentation ? t(activityPresentation.labelKey) : null,
        candidate.linkedSessionId ? t('externalSessions.browseLinked') : null,
        candidate.imported ? t('externalSessions.browseImported') : null,
        candidate.match?.snippet ? stripMarkdown(candidate.match.snippet) : null,
    ].filter((label): label is string => Boolean(label?.trim())))).join(', ');
}

function renderBrowseCandidateSubtitle(
    context: BrowseCandidatePresentationContext,
    candidate: ExternalSessionBrowseCandidate,
    candidatePath: string | null,
): React.ReactElement {
    const identity = resolveBrowseCandidateRowIdentity(context, candidate, candidatePath);
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
    deleteAction?: Readonly<{
        candidateKey: string;
        candidateTitle: string;
        deleting: boolean;
        onDelete: (candidate: ExternalSessionBrowseCandidate) => void;
    }> | null,
): React.ReactElement | null {
    const activity = candidate.activity;
    if (
        activity === undefined
        && !candidate.linkedSessionId
        && !candidate.imported
        && !deleteAction
    ) return null;
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
            {deleteAction ? (
                <ExternalSessionBrowseCandidateActions
                    candidateKey={deleteAction.candidateKey}
                    candidateTitle={deleteAction.candidateTitle}
                    deleting={deleteAction.deleting}
                    onDelete={() => deleteAction.onDelete(candidate)}
                />
            ) : null}
        </View>
    );
}

/**
 * The destructive Agent-side control for one listed candidate. It lives in an
 * always-present row overflow — never a hover-only affordance — so touch and
 * keyboard users reach it the same way, and it carries its own accessible name
 * because a bare ellipsis says nothing about which session it acts on.
 */
const ExternalSessionBrowseCandidateActions = React.memo(
    function ExternalSessionBrowseCandidateActions(props: Readonly<{
        candidateKey: string;
        candidateTitle: string;
        deleting: boolean;
        onDelete: () => void;
    }>) {
        const actions = React.useMemo((): ItemAction[] => [{
            id: 'delete_agent_session',
            title: t('common.delete'),
            icon: 'trash',
            destructive: true,
            disabled: props.deleting,
            onPress: props.onDelete,
        }], [props.deleting, props.onDelete]);
        return (
            <ItemRowActions
                title={props.candidateTitle}
                actions={actions}
                // One destructive control always behind the overflow: a compact
                // row must not surface a delete icon under the user's thumb.
                compactThreshold={Number.POSITIVE_INFINITY}
                compactActionIds={[]}
                overflowTriggerTestID={`external-session-candidate-actions:${props.candidateKey}`}
                overflowTriggerAccessibilityLabel={t(
                    'externalSessions.browseCandidateActionsAccessibilityLabel',
                    { title: props.candidateTitle },
                )}
            />
        );
    },
);

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
        deletingCandidateKey: string | null;
        candidateDeleteSupported: boolean;
        offline: boolean;
        interaction: ExternalSessionsBrowseInteraction;
        searchTarget: 'metadata' | 'content';
        searchQuery: string;
        hitStatusInMeta: boolean;
    }>;
    theme: AppTheme;
    density: ReturnType<typeof useResolvedItemDensity>;
    agentIdentity?: BrowseAgentIdentity | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
    selectionAuthorityGeneration: number;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => void;
    onDeleteCandidate: (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => void;
}>): SelectionListVirtualizedOptionSource {
    let titleByRemoteSessionId: Map<string, string> | undefined;
    if (params.candidates.some((candidate) => candidate.thread?.parentRemoteSessionId)) {
        titleByRemoteSessionId = new Map();
        for (const candidate of params.candidates) {
            if (candidate.title) titleByRemoteSessionId.set(candidate.remoteSessionId, candidate.title);
        }
    }
    const presentationContext: BrowseCandidatePresentationContext = {
        theme: params.theme,
        density: params.density,
        agentLabel: params.agentLabel,
        machineLabel: params.machineLabel,
        machineHomeDir: params.machineHomeDir,
        titleByRemoteSessionId,
    };
    const groups: BrowseCandidateProjectGroup[] = [];
    const projectGroupIndexByPath = new Map<string, number>();
    const candidatePaths: Array<string | null> = new Array(params.candidates.length);
    for (let candidateIndex = 0; candidateIndex < params.candidates.length; candidateIndex += 1) {
        const candidate = params.candidates[candidateIndex]!;
        const path = readExternalSessionBrowseCandidatePath(candidate);
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
        items.push({ kind: 'section-header', key: `project:${groups[groupIndex]!.path}::header`, sectionIndex: groupIndex });
        for (const candidateIndex of groups[groupIndex]!.candidateIndexes) {
            positionInSet += 1;
            navigationOptionIndexes.push(candidateIndex);
            const candidate = params.candidates[candidateIndex]!;
            items.push({
                kind: 'option',
                // Read lazily (only mounted rows are keyed by the window), but from this listing's
                // own candidate, so a row of a replaced listing still keys itself.
                get key() {
                    return readExternalSessionBrowseCandidateKey(candidate);
                },
                optionIndex: candidateIndex,
                positionInSet,
            });
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
    /**
     * Deletion is fenced by the same selection authority as activation: this
     * source is rebuilt whenever the browse scope changes, so a control still
     * reachable from the previous listing — a row overflow left open across the
     * switch — carries the generation it was rendered for.
     */
    const deleteCandidateAtSelectionAuthority = (candidate: ExternalSessionBrowseCandidate): void => {
        params.onDeleteCandidate(candidate, params.selectionAuthorityGeneration);
    };
    /**
     * Linking is single-flight at the screen owner: while one link is in flight it
     * drops every other candidate activation. A row that still looks pressable but
     * is silently ignored is a lie, so activation is withheld from the whole list —
     * not only the pending row — for as long as a link is outstanding. The pending
     * row keeps its own spinner, and closing the surface stays available.
     */
    const isFocusableOptionIndex = (candidateIndex: number): boolean => {
        const interaction = params.getInteractionState();
        return !interaction.candidateActionsDisabled
            && interaction.linkingSessionId === null
            && candidateIndex >= 0
            && candidateIndex < params.candidates.length
            && (interaction.searchTarget !== 'content' || getCandidate(candidateIndex).match !== undefined)
            && !isExternalSessionBrowseCandidateOfflineInert({
                offline: interaction.offline,
                interaction: interaction.interaction,
                linkedSessionId: params.candidates[candidateIndex]?.linkedSessionId,
            });
    };

    return {
        items,
        optionCount: params.candidates.length,
        get stateKey(): string {
            const interaction = params.getInteractionState();
            return [
                interaction.candidateActionsDisabled ? 'disabled' : 'enabled',
                interaction.linkingSessionId ?? '',
                interaction.candidateDeleteSupported ? 'deletable' : 'undeletable',
                interaction.deletingCandidateKey ?? '',
                interaction.offline ? 'offline' : 'online',
                interaction.interaction,
                interaction.searchTarget,
                interaction.hitStatusInMeta ? 'status-in-meta' : 'status-beside-title',
            ].join('\u0000');
        },
        getOption: (candidateIndex: number): SelectionListOption => {
            const candidate = getCandidate(candidateIndex);
            const candidateKey = readExternalSessionBrowseCandidateKey(candidate);
            const candidatePath = candidatePaths[candidateIndex] ?? null;
            const interaction = params.getInteractionState();
            const isPending = candidateKey === interaction.linkingSessionId;
            const agentIdentity = params.agentIdentity;
            return {
                id: candidateKey,
                testID: `direct-session-candidate:${candidateKey}`,
                // Browse owns server-side search, so this stays a cheap
                // synchronous matching fallback while the visible title is
                // resolved only by the mounted SelectionList row.
                label: resolveBrowseCandidateMatchingLabel(candidate),
                renderLabel: () => {
                    const title = resolveBrowseCandidateIdentity(presentationContext, candidate, candidatePath).title;
                    return interaction.searchTarget === 'content' ? stripMarkdown(title) : title;
                },
                renderAccessibilityLabel: () => resolveBrowseCandidateAccessibilityLabel(
                    presentationContext,
                    candidate,
                    candidatePath,
                ),
                icon: agentIdentity ? () => (
                    <AgentCatalogIdentityIcon
                        entry={agentIdentity.entry}
                        machineId={agentIdentity.machineId}
                        serverId={agentIdentity.serverId}
                        current={agentIdentity.current}
                        size={20}
                        testID={`external-session-candidate-agent:${candidate.remoteSessionId}`}
                    />
                ) : undefined,
                subtitle: candidatePath ?? '',
                // A hit's mark and status belong to its title; the snippet and meta run beneath (lab H2).
                ...(interaction.searchTarget === 'content'
                    ? { contentAlign: 'start' as const, labelHighlightQuery: interaction.searchQuery.trim() || undefined } : {}),
                subtitleContent: () => interaction.searchTarget === 'content'
                    ? <ConversationHitSummary
                        snippet={resolveConversationHitSnippet({
                            title: resolveBrowseCandidateIdentity(presentationContext, candidate, candidatePath).title,
                            snippet: candidate.match?.snippet ?? t('externalSessions.browseContentNotSearchable'), query: interaction.searchQuery,
                        })}
                        query={interaction.searchQuery}
                        where={resolveConversationHitWhere(resolveBrowseCandidateRowIdentity(presentationContext, candidate, candidatePath))}
                        atMs={candidate.updatedAtMs} messageCount={candidate.messageCount}
                        status={interaction.hitStatusInMeta ? resolveConversationHitStatusLabel(candidate) : null} testID={`external-session-candidate-match:${candidate.remoteSessionId}`} />
                    : renderBrowseCandidateSubtitle(presentationContext, candidate, candidatePath),
                // A hit says once whether it is already in Happier (lab H2); Titles keeps its Linked/Imported marks.
                rightAccessory: () => interaction.searchTarget === 'content'
                    ? interaction.hitStatusInMeta ? null : <ConversationHitStatus candidate={candidate} testID={`external-session-candidate-status:${candidate.remoteSessionId}`} />
                    : renderBrowseCandidateRightAccessory(
                    candidate,
                    interaction.candidateDeleteSupported
                        ? {
                            candidateKey,
                            candidateTitle: resolveBrowseCandidateMatchingLabel(candidate),
                            // One deletion at a time: the screen serializes on
                            // a single pending key and silently drops a second
                            // press, so while any candidate is being deleted
                            // every delete control is suspended. Progress still
                            // belongs to the row actually being deleted — see
                            // `loading` below.
                            deleting: interaction.deletingCandidateKey !== null,
                            onDelete: deleteCandidateAtSelectionAuthority,
                        }
                        : null,
                ),
                // The overflow control is interactive, so it must not live inside
                // the row's own activation target.
                rightAccessoryOutsidePressable: interaction.candidateDeleteSupported,
                onSelect: () => params.onSelectCandidate(candidate, params.selectionAuthorityGeneration),
                disabled: interaction.candidateActionsDisabled
                    || (interaction.searchTarget === 'content' && candidate.match === undefined)
                    || interaction.linkingSessionId !== null
                    || isExternalSessionBrowseCandidateOfflineInert({
                        offline: interaction.offline,
                        interaction: interaction.interaction,
                        linkedSessionId: candidate.linkedSessionId,
                    }),
                loading: isPending || interaction.deletingCandidateKey === candidateKey,
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
            for (const candidateIndex of navigationOptionIndexes) {
                if (isFocusableOptionIndex(candidateIndex)) return candidateIndex;
            }
            return -1;
        },
        getNextFocusableOptionIndex: (currentCandidateIndex: number, direction: -1 | 1): number => {
            if (navigationOptionIndexes.length === 0) return -1;
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
                    : formatSessionPath(group.path, params.machineHomeDir ?? undefined),
                // A project folder is a path; the "Conversations" fallback is a word.
                monoTitle: group.path !== UNKNOWN_PROJECT_KEY,
                count: group.candidateIndexes.length,
                rightAccessory: params.getInteractionState().searchTarget === 'content'
                    && group.candidateIndexes.some(index => getCandidate(index).searchMode === 'indexed')
                    && group.candidateIndexes.some(index => getCandidate(index).searchMode === 'standard')
                    ? t('conversationSearch.mixedResults') : undefined,
            };
        },
    };
}

/**
 * Loading and indexing, one presentation. Before anything arrives the list shows skeleton rows in
 * place of the results (no "Loading…" text). While a candidate index builds, a 2px progress line and
 * one status line with Stop sit on the list's top edge, above the rows it has already served (or
 * above the skeleton rows while it has served none); the progress region and Stop never appear twice.
 */
function BrowseLoadingState(props: Readonly<{
    preparation: ExternalSessionBrowsePreparation | null;
    onCancelPreparation?: () => void;
    /** `banner` sits above served rows; `content` fills the empty list area. */
    placement?: 'content' | 'banner';
}>): React.ReactElement {
    const isBanner = props.placement === 'banner';
    const preparation = props.preparation;
    const total = preparation?.total;
    const progressLabel = total === undefined
        ? t('externalSessions.browseIndexing')
        : t('externalSessions.browseIndexingProgress', {
            scanned: preparation!.scanned,
            total,
        });
    const skeleton = isBanner ? null : (
        <SkeletonRows rows={7} {...SELECTION_LIST_SKELETON_ROW_SHAPE} rowTestID={(index) => `direct-session-candidates:loading:row-${index}`} />
    );
    if (!preparation) {
        return (
            <View style={styles.loading}>
                <View
                    testID="direct-session-candidates:loading"
                    style={styles.loadingProgressRegion}
                    accessibilityRole="text"
                    accessibilityLabel={t('common.loading')}
                    accessibilityLiveRegion="polite"
                    {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                >
                    {skeleton}
                </View>
            </View>
        );
    }
    return (
        <View style={isBanner ? styles.indexing : [styles.indexing, styles.loading]}>
            <ExternalSessionSearchProgress label={progressLabel} scanned={preparation.scanned} total={total}
                onStop={props.onCancelPreparation} testID="direct-session-candidates:indexing" stopTestID="direct-session-candidates:indexing:cancel" />
            {skeleton}
        </View>
    );
}

/**
 * The machine scope the browser is looking at, owned by the screen. It decides which state speaks
 * first: a missing machine or an absent choice outranks anything the (unreachable) machine's agents
 * could report.
 */
export type ExternalSessionBrowseScope =
    | Readonly<{ kind: 'ready' }>
    | Readonly<{ kind: 'unselected'; onChooseMachine?: () => void }>
    | Readonly<{ kind: 'gone'; homeName: string | null; onChooseMachine?: () => void }>
    /** The inventory read's own status, without inferring whether its Home is reachable. */
    | Readonly<{ kind: 'inventory'; status: 'loading' | 'error' | 'signedOut'; onChooseMachine?: () => void }>
    | Readonly<{ kind: 'offline'; onChooseMachine?: () => void }>
    | Readonly<{ kind: 'locked'; onChooseMachine?: () => void }>;

const READY_SCOPE: ExternalSessionBrowseScope = { kind: 'ready' };

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
    deletingCandidateKey?: string | null;
    candidateDeleteSupported?: boolean;
    candidateActionsDisabled?: boolean;
    interaction?: ExternalSessionsBrowseInteraction;
    searchQuery: string;
    searchTarget?: 'metadata' | 'content';
    contentSearchSupported?: boolean;
    contentSearchExplicitlyUnsupported?: boolean;
    contentSearchSubmitted?: boolean;
    contentCoverage?: 'complete' | 'partial' | 'unsupported' | null;
    contentCoverageLabel?: string;
    contentScanAvailable?: boolean;
    /** Set when Search on demand is off on the machine, so Return cannot scan; opens Settings › Search. */
    onOpenContentSearchSettings?: () => void;
    onSearchSubmit?: (query: string) => void;
    onSearchQueryChange: (query: string) => void;
    selectionAuthorityGeneration: number;
    onSelectCandidate: (candidate: ExternalSessionBrowseCandidate, selectionAuthorityGeneration: number) => void;
    onDeleteCandidate?: (
        candidate: ExternalSessionBrowseCandidate,
        selectionAuthorityGeneration: number,
    ) => void;
    onLoadMore: () => void;
    onRetry?: () => void;
    onCancelPreparation?: () => void;
    onRequestClose?: () => void;
    agentIdentity?: BrowseAgentIdentity | null;
    agentLabel?: string | null;
    machineLabel?: string | null;
    machineHomeDir?: string | null;
    sourceLabel?: string | null;
    projectionPhase?: 'loading' | 'ready' | 'unsupported' | 'error';
    /** Why the projection read failed, with `projectionPhase: 'error'`. */
    projectionFailureReason?: MachineContributionRegistryProjectionFailureReason;
    browseCapabilityAvailable?: boolean;
    /** The machine scope; see {@link ExternalSessionBrowseScope}. Absent means ready. */
    scope?: ExternalSessionBrowseScope;
    /** The browser's scope (machine, Agent, source) as SelectionList filters beside the search band. */
    filters?: ReadonlyArray<SelectionListFilter>;
    /** Controls that trail the search band after the filters (the ⋯ menu, close). */
    bandTrailing?: React.ReactNode;
    /** What the field searches (Titles | Conversations), on a row beneath it where the band has no room for it. */
    searchTargetRow?: React.ReactNode;
    /** The search band's placeholder ("Search Claude sessions…"). */
    searchPlaceholder?: string;
    /** Another agent on this machine that can share sessions, offered when this one has none. */
    alternativeAgent?: Readonly<{ label: string; onSelect: () => void }> | null;
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
    const onDeleteCandidateRef = React.useRef(props.onDeleteCandidate);
    onDeleteCandidateRef.current = props.onDeleteCandidate;
    const handleDeleteCandidate = React.useCallback((
        candidate: ExternalSessionBrowseCandidate,
        selectionAuthorityGeneration: number,
    ) => {
        onDeleteCandidateRef.current?.(candidate, selectionAuthorityGeneration);
    }, []);
    const candidateActionsDisabled = props.candidateActionsDisabled === true;
    // The affordance needs both the listing's advertisement and a consumer that
    // can actually perform it; either one missing keeps the row read-only.
    const candidateDeleteSupported = props.candidateDeleteSupported === true
        && props.onDeleteCandidate !== undefined;
    const offline = props.offline === true;
    const interaction: ExternalSessionsBrowseInteraction = props.interaction ?? 'openSession';
    const searchTarget = props.searchTarget ?? 'metadata';
    const isContentSearch = searchTarget === 'content';
    // The list's own width, not the window's: Browse is often a pane or a sheet. Only the boolean is state.
    const [hitStatusInMeta, setHitStatusInMeta] = React.useState(false);
    const handleRootLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = isConversationHitStatusInMeta(event.nativeEvent.layout.width);
        setHitStatusInMeta((current) => (current === next ? current : next));
    }, []);
    const interactionStateRef = React.useRef({
        candidateActionsDisabled,
        linkingSessionId: props.linkingSessionId,
        deletingCandidateKey: props.deletingCandidateKey ?? null,
        candidateDeleteSupported,
        offline,
        interaction,
        searchTarget,
        searchQuery: props.searchQuery,
        hitStatusInMeta,
    });
    interactionStateRef.current = {
        candidateActionsDisabled,
        linkingSessionId: props.linkingSessionId,
        deletingCandidateKey: props.deletingCandidateKey ?? null,
        candidateDeleteSupported,
        offline,
        interaction,
        searchTarget,
        searchQuery: props.searchQuery,
        hitStatusInMeta,
    };
    const getInteractionState = React.useCallback(() => interactionStateRef.current, []);
    const virtualizedOptionSource = React.useMemo(
        () => props.candidates.length === 0 ? null : buildCandidateVirtualizedSource({
            candidates: props.candidates,
            getInteractionState,
            theme,
            density: itemDensity,
            agentIdentity: props.agentIdentity,
            agentLabel: props.agentLabel,
            machineLabel: props.machineLabel,
            machineHomeDir: props.machineHomeDir,
            selectionAuthorityGeneration: props.selectionAuthorityGeneration,
            onSelectCandidate: handleSelectCandidate,
            onDeleteCandidate: handleDeleteCandidate,
        }),
        [
            getInteractionState,
            handleDeleteCandidate,
            handleSelectCandidate,
            itemDensity,
            props.agentIdentity,
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
        return {
            id: 'external-session-candidates',
            inputPlaceholder: props.searchPlaceholder ?? t('externalSessions.browseSearchPlaceholder'),
            disableInputFilter: true,
            // The same keys as Search / ⌘K, shown only with a hardware keyboard.
            footerHints: [
                { id: 'move', label: '↑↓', description: t('commandPalette.hints.move') },
                { id: 'open', label: '↵', description: t('commandPalette.hints.open') },
                { id: 'close', label: 'esc', description: t('commandPalette.hints.close') },
            ],
            // Only reached while a cursor page is still continuing; a settled empty listing and a
            // search without matches are content states below.
            emptyStateLabel: isContentSearch ? '' : t(hasSearchQuery
                ? 'externalSessions.browseNoSearchResults'
                : 'externalSessions.browseNoCandidates'),
            sections: [],
            ...(virtualizedOptionSource === null ? {} : { virtualizedOptionSource }),
        };
    }, [isContentSearch, props.searchPlaceholder, props.searchQuery, virtualizedOptionSource]);
    const handleSelect = React.useCallback(() => undefined, []);
    const searchIncompleteAnnouncement = !isContentSearch && props.searchIncomplete && props.candidates.length > 0
        ? t('externalSessions.browseSearchIncomplete', {
            count: props.candidates.length,
        })
        : null;
    // Statuses are still being established while the index builds: the progress row says so. Only a
    // listing that finished and still could not confirm some statuses shows the notice.
    const showAnnotationsIncomplete = props.annotationsIncomplete && props.candidates.length > 0 && props.preparation === null;
    const annotationsIncompleteAnnouncement = showAnnotationsIncomplete
        ? t('externalSessions.browseAnnotationsIncomplete')
        : null;
    // One message per state: with rows on screen, "Search more conversations" or the footer's failure
    // already says the search is unfinished, so the coverage line speaks only when nothing else does.
    const showContentCoverage = isContentSearch && props.contentCoverage !== 'complete'
        && (props.candidates.length > 0
            ? props.nextCursor === null && !props.error
            : props.contentCoverage === 'partial' && props.nextCursor !== null && !props.error);
    // With rows on screen the coverage closes the list (lab H2 "Searched …"); with none and more to search it
    // says what is true, that nothing has matched yet, rather than blaming coverage.
    const contentCoverageLine = showContentCoverage
        ? t(props.candidates.length > 0 ? 'externalSessions.browseContentPartial' : 'externalSessions.browseContentNothingYet')
        : null;
    // History's words when the search says which machine was not covered (one coverage voice on both surfaces).
    const contentCoverageText = props.contentCoverageLabel || contentCoverageLine;
    const contentCoverageAnnouncement = isContentSearch ? contentCoverageText || null : contentCoverageLine;
    const incompleteAnnouncement = [searchIncompleteAnnouncement, contentCoverageAnnouncement, annotationsIncompleteAnnouncement]
        .filter((announcement): announcement is string => announcement !== null)
        .join(' ') || null;
    useIosAccessibilityAnnouncement(incompleteAnnouncement);

    const hasLoadedRows = props.candidates.length > 0;
    // "Search more conversations" that adds no row changes nothing on screen, so the list says what happened.
    // The row count at the press is the reference; a page that failed is the error line's to report.
    const [askedAtRows, setAskedAtRows] = React.useState<number | null>(null);
    const searchMoreConversations = React.useCallback(() => {
        setAskedAtRows(props.candidates.length);
        props.onLoadMore();
    }, [props.candidates.length, props.onLoadMore]);
    const nothingNewFromMore = isContentSearch && hasLoadedRows && askedAtRows !== null && !props.loading && !props.loadingMore
        && !props.error && !props.cancelled && props.candidates.length <= askedAtRows;
    /**
     * Once the preparing index serves rows, the full-height loading state stands down
     * and this banner takes over the same progress region and the same cancel
     * affordance, so a multi-thousand-round-trip build stays explained and stoppable
     * instead of silently continuing behind the rows it has published.
     */
    const indexingBannerVisible = hasLoadedRows && props.preparation !== null;
    const projectionPhase = props.projectionPhase ?? 'ready';
    const scope = props.scope ?? READY_SCOPE;
    const projectionFailureCopy = projectionPhase === 'unsupported' || projectionPhase === 'error'
        ? resolveBrowseProjectionFailureCopy({
            phase: projectionPhase,
            failureReason: props.projectionFailureReason,
            machineName: props.machineLabel?.trim() || null,
        })
        : null;
    // Retained rows stay usable; the footer line names what failed beside Retry.
    const projectionFailureMessage = projectionFailureCopy?.title ?? null;
    // The visible loading state is a live region on web/Android; iOS mirrors it.
    // An index build is announced by the hidden status below instead, because its
    // visible progress deliberately is not live (count ticks must not speak).
    const loadingAnnouncement = !props.preparation
        && !hasLoadedRows && (projectionPhase === 'loading' || props.loading || props.loadingMore
            || (scope.kind === 'inventory' && scope.status === 'loading'))
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
        ? t(isContentSearch ? 'externalSessions.browseContentStopped' : 'externalSessions.browseIndexingCancelled')
        : null;
    const presentationError = props.offline
        ? t('externalSessions.browseMachineOfflineBody')
        : props.error;
    const retainedRowsLoading = hasLoadedRows
        && (props.loading || projectionPhase === 'loading');
    const machineName = props.machineLabel?.trim() || null;
    const machineInSentence = machineName ?? t('externalSessions.browseThisMachine');
    const trimmedQuery = props.searchQuery.trim();
    const onChooseMachine = scope.kind === 'ready' ? undefined : scope.onChooseMachine;
    const chooseAnother = onChooseMachine
        ? { label: t('externalSessions.browseChooseAnotherMachine'), onPress: onChooseMachine }
        : undefined;
    const retry = props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined;
    const offlineTitle = machineName
        ? t('externalSessions.browseMachineOfflineTitle', { machine: machineName })
        : t('externalSessions.browseThisMachineOfflineTitle');
    /**
     * One state speaks at a time, in order of what the user must fix first: the machine choice, a
     * machine that is gone or away, the machine's Happier service, whether any agent there can share,
     * then the listing itself. A missing machine therefore never reads as "no agent can browse".
     * The toolbar above stays on screen in every state, since it holds the control that recovers it.
     */
    const contentState = hasLoadedRows ? undefined : scope.kind === 'unselected' ? (
        <SurfaceStateCard
            testID="direct-session-candidates:no-machine"
            kind="empty"
            iconName="desktop"
            title={t('externalSessions.browseChooseMachineTitle')}
            reason={t('externalSessions.browseChooseMachineBody')}
            action={onChooseMachine
                ? { label: t('externalSessions.browseChooseMachineTitle'), onPress: onChooseMachine }
                : undefined}
        />
    ) : scope.kind === 'gone' ? (
        <SurfaceStateCard
            testID="direct-session-candidates:machine-gone"
            kind="unavailable"
            iconName="desktop"
            accessibilitySemantics="status"
            title={scope.homeName
                ? t('settingsPlugins.targetSelection.missingInHome', { home: scope.homeName })
                : t('settingsPlugins.targetSelection.missingInThisHome')}
            reason={t('externalSessions.browseMachineGoneBody')}
            action={onChooseMachine
                ? { label: t('settingsPlugins.targetSelection.chooseAnother'), onPress: onChooseMachine }
                : undefined}
        />
    ) : scope.kind === 'inventory' && scope.status === 'loading' ? (
        <BrowseLoadingState preparation={null} />
    ) : scope.kind === 'inventory' ? (
        <SurfaceStateCard
            testID="direct-session-candidates:inventory-unavailable"
            kind={scope.status === 'error' ? 'error' : 'unavailable'}
            iconName="desktop"
            accessibilitySemantics="status"
            title={scope.status === 'signedOut' ? t('server.signedOut') : t('common.unavailable')}
            action={onChooseMachine
                ? { label: t('settingsPlugins.targetSelection.chooseAnother'), onPress: onChooseMachine }
                : undefined}
        />
    ) : scope.kind === 'locked' ? (
        <SurfaceStateCard
            testID="direct-session-candidates:machine-locked"
            kind="unavailable"
            iconName="lock"
            accessibilitySemantics="status"
            title={t('settingsPlugins.targetSelection.locked')}
            action={chooseAnother}
        />
    ) : scope.kind === 'offline' || (props.offline && props.error && props.nextCursor === null) ? (
        <SurfaceStateCard
            testID="direct-session-candidates:offline"
            kind="unavailable"
            iconName="cloud-slash"
            accessibilitySemantics="alert"
            title={offlineTitle}
            reason={t('externalSessions.browseMachineOfflineBody')}
            action={scope.kind === 'offline' ? chooseAnother : retry}
        />
    ) : projectionPhase === 'loading' ? (
        <BrowseLoadingState preparation={null} />
    ) : projectionPhase === 'unsupported' || projectionPhase === 'error' ? (
        <SurfaceStateCard
            testID={projectionPhase === 'unsupported'
                ? 'direct-session-candidates:unavailable'
                : 'direct-session-candidates:projection-error'}
            kind={projectionPhase === 'unsupported' ? 'unavailable' : 'error'}
            iconName="link-break"
            accessibilitySemantics="alert"
            title={projectionFailureCopy?.title ?? ''}
            reason={projectionFailureCopy?.reason}
            diagnosticCode={projectionFailureCopy?.diagnosticCode}
            action={retry}
        />
    ) : props.browseCapabilityAvailable === false ? (
        <SurfaceStateCard
            testID="direct-session-candidates:no-agents"
            kind="unavailable"
            iconName="cpu"
            title={t('externalSessions.browseNothingToBrowseTitle', { machine: machineInSentence })}
            reason={t('externalSessions.browseNothingToBrowseBody')}
        />
    ) : isContentSearch && props.contentSearchSupported !== true ? (
        <SurfaceStateCard
            testID="direct-session-candidates:content-unsupported"
            kind="unavailable"
            iconName="magnifying-glass"
            title={props.contentSearchExplicitlyUnsupported
                ? t('externalSessions.browseContentNotSearchable')
                : t('externalSessions.browseContentUpdateRequired', { machine: machineInSentence })}
        />
    ) : isContentSearch && props.contentSearchSubmitted !== true && props.onOpenContentSearchSettings ? (
        // A prompt to press Return would invite an action that cannot succeed: say why and lead to the setting.
        <EmptyState
            layout="line"
            testID="direct-session-candidates:content-scan-off"
            title={t('externalSessions.browseContentScanOff', { machine: machineInSentence })}
            primaryAction={{ label: t('externalSessions.browseContentScanOffSettings'), onPress: props.onOpenContentSearchSettings,
                testID: 'direct-session-candidates:content-scan-off:settings' }}
        />
    ) : isContentSearch && props.contentSearchSubmitted !== true ? (
        <EmptyState
            layout="line"
            testID="direct-session-candidates:content-unsearched"
            // With a phrase in the field the next step is running it, not typing one.
            title={trimmedQuery
                ? t('externalSessions.browseContentSearchReady', { query: trimmedQuery })
                : t('externalSessions.browseContentSearchPrompt')}
        />
    ) : props.loading || props.loadingMore || props.preparation !== null ? (
        <BrowseLoadingState
            preparation={props.preparation}
            onCancelPreparation={isContentSearch ? undefined : props.onCancelPreparation}
        />
    ) : props.cancelled ? (
        <SurfaceStateCard
            testID="direct-session-candidates:cancelled"
            kind="unavailable"
            iconName="stop"
            accessibilitySemantics="status"
            title={t(isContentSearch ? 'externalSessions.browseContentStopped' : 'externalSessions.browseIndexingCancelled')}
            action={retry}
        />
    ) : props.error && props.nextCursor === null ? (
        <SurfaceStateCard
            testID="direct-session-candidates:error"
            kind="error"
            accessibilitySemantics="alert"
            title={isContentSearch
                ? t('externalSessions.browseContentErrorTitle', { machine: machineInSentence })
                : t('externalSessions.browseErrorTitle')}
            reason={props.error}
            action={retry}
        />
    ) : isContentSearch && props.contentCoverage !== 'complete' && props.nextCursor === null ? (
        <EmptyState
            layout="line"
            testID="direct-session-candidates:content-partial-empty"
            title={t('externalSessions.browseContentPartial')}
        />
    ) : props.nextCursor !== null ? undefined : trimmedQuery ? (
        <EmptyState
            layout="line"
            testID="direct-session-candidates:no-matches"
            title={t('externalSessions.browseNoMatches', { query: trimmedQuery })}
            action={(
                <HappierPressable
                    testID="direct-session-candidates:no-matches:clear"
                    accessibilityRole="button"
                    accessibilityLabel={t('common.clearSearch')}
                    onPress={() => props.onSearchQueryChange('')}
                >
                    <Text style={styles.noMatchesClear}>{t('common.clearSearch')}</Text>
                </HappierPressable>
            )}
        />
    ) : (
        <SurfaceStateCard
            testID="direct-session-candidates:empty"
            kind="empty"
            iconName="clock-counter-clockwise"
            title={t('externalSessions.browseEmptyTitle', {
                agent: props.agentLabel?.trim() || t('externalSessions.browseAgents'),
                machine: machineInSentence,
            })}
            reason={t('externalSessions.browseEmptyBody')}
            secondaryAction={props.alternativeAgent
                ? {
                    label: t('externalSessions.browseTryAgent', { agent: props.alternativeAgent.label }),
                    onPress: props.alternativeAgent.onSelect,
                }
                : undefined}
        />
    );

    /**
     * The listing's status lines (index progress, incomplete search or statuses) sit under the search
     * band, above the rows, so the band stays the top of the card as in Search / ⌘K.
     */
    // Stop belongs to a search the user started; the quiet lookup behind a typed phrase still offers Search.
    const contentSearchRunning = props.contentSearchSubmitted === true && (props.loading || props.loadingMore === true);
    const hasStatusRows = indexingBannerVisible
        || (showContentCoverage && props.candidates.length === 0)
        || (!isContentSearch && props.candidates.length > 0 && props.searchIncomplete === true)
        || showAnnotationsIncomplete;
    const statusRows = hasStatusRows ? (
        <View testID="direct-session-candidates-status">
            {showContentCoverage && props.candidates.length === 0 ? (
                <Text
                    testID="direct-session-candidates-content-partial"
                    style={styles.searchIncomplete}
                    accessibilityLiveRegion="polite"
                >
                    {contentCoverageLine}
                </Text>
            ) : null}
            {indexingBannerVisible ? (
                <BrowseLoadingState
                    placement="banner"
                    preparation={props.preparation}
                    onCancelPreparation={isContentSearch ? undefined : props.onCancelPreparation}
                />
            ) : null}
            {!isContentSearch && props.searchIncomplete && props.candidates.length > 0 ? (
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
            {showAnnotationsIncomplete ? (
                <Text
                    testID="direct-session-candidates-annotations-incomplete"
                    style={styles.searchIncomplete}
                    accessibilityLiveRegion="polite"
                    {...({ role: 'status', 'aria-live': 'polite' } as Record<string, unknown>)}
                >
                    {t('externalSessions.browseAnnotationsIncomplete')}
                </Text>
            ) : null}
        </View>
    ) : undefined;

    return (
        <View testID="direct-session-candidates-root" style={styles.root} onLayout={handleRootLayout}>
            <PoliteAccessibilityStatus
                announcement={props.preparation ? t('externalSessions.browseIndexing') : ''}
                statusTestID="direct-session-candidates:indexing:a11y-status"
                transitionKey={props.preparation ? 'indexing' : 'idle'}
            />
            <SelectionList
                rootStep={rootStep}
                inputMode={isContentSearch ? 'value' : 'search'}
                onCommitInputValue={isContentSearch ? props.onSearchSubmit : undefined}
                inputValue={props.searchQuery}
                inputTestID="direct-session-candidates-search-input"
                onChangeInputValue={props.onSearchQueryChange}
                selectionMark="enter"
                filters={props.filters}
                inputAccessoryRow={props.searchTargetRow || statusRows ? (
                    <>
                        {props.searchTargetRow ? <View style={styles.searchTargetRow}>{props.searchTargetRow}</View> : null}
                        {statusRows}
                    </>
                ) : undefined}
                inputSuffix={isContentSearch || props.searchAugmenting || props.bandTrailing ? (
                    <View style={styles.searchSuffix}>
                        {/* In Conversations the field's Search becomes Stop in place; the progress band does not repeat it. */}
                        {isContentSearch && (props.contentScanAvailable !== false || props.loading || props.loadingMore) ? (
                            <RoundButton
                                testID="direct-session-candidates-content-submit"
                                size="small"
                                // A quiet control beside the field: Return runs the search too.
                                display="secondary"
                                title={t(contentSearchRunning ? 'externalSessions.browseIndexingStop' : 'externalSessions.browseContentSubmit')}
                                disabled={props.contentSearchSupported !== true
                                    || (contentSearchRunning ? !props.onCancelPreparation : !props.onSearchSubmit || !props.searchQuery.trim())}
                                onPress={() => {
                                    if (contentSearchRunning) props.onCancelPreparation?.();
                                    else props.onSearchSubmit?.(props.searchQuery);
                                }}
                            />
                        ) : null}
                        {props.searchAugmenting ? (
                            <View
                                testID="direct-session-candidates-search-augmenting"
                                style={styles.searchProgress}
                            >
                                <ActivitySpinner
                                    size="small"
                                    accessibilityLabel={t('common.loading')}
                                />
                            </View>
                        ) : null}
                        {props.bandTrailing ?? null}
                    </View>
                ) : undefined}
                onSelect={handleSelect}
                onRequestClose={props.onRequestClose ?? (() => undefined)}
                // Opening browse lands on the search field, not on the band's ⋯.
                autoFocusInputOnWeb
                disableTransitions
                testID="direct-session-candidates"
                fillAvailableSpace
                showsVerticalScrollIndicator
                contentState={contentState}
                pagination={hasLoadedRows || props.nextCursor !== null ? {
                    hasMore: props.nextCursor !== null,
                    loadingMore: props.loadingMore || retainedRowsLoading,
                    requestKey: props.paginationRequestKey,
                    // Retained rows outlive the connection. Without the offline
                    // presentation here the footer falls through to the end-of-list
                    // marker and asserts the listing is complete while it is stale.
                    error: presentationError ?? projectionFailureMessage ?? stoppedIndexNotice,
                    onEndReached: isContentSearch ? searchMoreConversations : props.onLoadMore,
                    moreNotice: nothingNewFromMore && props.nextCursor !== null ? t('conversationSearch.moreNothingNew') : null,
                    onRetry: props.onRetry,
                    loadingLabel: t('common.loading'),
                    moreLabel: t(isContentSearch ? 'externalSessions.browseContentMore' : 'common.more'),
                    retryLabel: t('common.retry'),
                    // A conversation search ends with what it could not cover, or with nothing at all.
                    // A conversation search closes with what it could not cover, on the rows' edge like History's line, or with nothing.
                    endReachedLabel: isContentSearch
                        ? [nothingNewFromMore ? t('conversationSearch.moreExhausted') : '', showContentCoverage ? contentCoverageText ?? '' : ''].filter(Boolean).join(' ')
                        : t('common.done'),
                    ...(isContentSearch ? { endReachedPlacement: 'edge' as const } : {}),
                } : undefined}
            />
        </View>
    );
});
