import * as React from 'react';
import { Platform, View } from 'react-native';
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
import { MeterBar } from '@/components/ui/lists/MeterBar';
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
import { SelectionListSkeletonRow } from '@/components/ui/selectionList/SelectionListSkeletonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import {
    resolveStatusPillVariantForState,
    StatusPill,
} from '@/components/ui/status/StatusPill';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { findExternalSessionContentMatchRange } from '@happier-dev/protocol';
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
        paddingTop: 8,
    },
    loadingProgressRegion: {
        width: '100%',
    },
    searchSuffix: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    searchProgress: {
        paddingHorizontal: 4,
    },
    searchIncomplete: {
        color: theme.colors.text.secondary,
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    // Indexing: a 2px line across the list's top edge and one status line under it, with Stop at its
    // end. Rows the index has already served stay live below it.
    indexing: {
        width: '100%',
    },
    indexingStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 6,
    },
    indexingRegion: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    indexingLabel: {
        ...Typography.default(),
        fontSize: 12.5,
        lineHeight: 18,
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    noMatchesClear: {
        ...Typography.default('medium'),
        fontSize: 13,
        lineHeight: 18,
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

/** The candidate's name without row context (search matching, the delete confirmation): the same owner. */
function resolveBrowseCandidateMatchingLabel(candidate: ExternalSessionBrowseCandidate): string {
    return resolveExternalSessionBrowseCandidateIdentityPresentation({
        remoteSessionId: candidate.remoteSessionId,
        title: candidate.title,
        path: null,
    }).title;
}

/**
 * Shared by the browser and Search: render decoded visible text, never source JSON. The searched words
 * carry the Find tint every surface uses (Find lab H1/H2), located by the same owner that cut the snippet.
 */
export function ExternalSessionCandidateMatch(props: Readonly<{
    candidate: ExternalSessionBrowseCandidate;
    /** The query the snippet answers; its first literal occurrence is marked. */
    query?: string;
    /**
     * `row` (default): a clamped secondary line under the hit. `preview`: the whole snippet as the
     * message being previewed, its match drawn as the current one (Find lab H1r).
     */
    presentation?: 'row' | 'preview';
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles() as { theme: AppTheme };
    const density = useResolvedItemDensity(undefined);
    const snippet = props.candidate.match?.snippet;
    const query = props.query?.trim() ?? '';
    const range = snippet && query ? findExternalSessionContentMatchRange(snippet, query) : null;
    const preview = props.presentation === 'preview';
    return (
        <Text
            testID={props.testID ?? `external-session-candidate-match:${props.candidate.remoteSessionId}`}
            style={preview
                ? [Typography.default(), { fontSize: 14, lineHeight: 20, color: theme.colors.text.primary }]
                : [Typography.default(), ITEM_SUBTITLE_TEXT_METRICS[density], { color: theme.colors.text.secondary }]}
            numberOfLines={preview ? undefined : 3}
            selectable={preview}
        >
            {snippet === undefined
                ? t('externalSessions.browseContentNotSearchable')
                : <FindHighlightedText text={snippet} ranges={range ? [{ ...range, current: preview }] : undefined} />}
        </Text>
    );
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
        candidate.match?.snippet,
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
                subtitleContent: () => interaction.searchTarget === 'content'
                    ? <ExternalSessionCandidateMatch candidate={candidate} query={interaction.searchQuery} />
                    : renderBrowseCandidateSubtitle(presentationContext, candidate, candidatePath),
                rightAccessory: () => renderBrowseCandidateRightAccessory(
                    candidate,
                    interaction.candidateDeleteSupported && (interaction.searchTarget !== 'content' || candidate.match !== undefined)
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
                    : formatPathRelativeToHome(group.path, params.machineHomeDir ?? undefined),
                count: group.candidateIndexes.length,
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
    const { theme } = useUnistyles() as { theme: AppTheme };
    const isBanner = props.placement === 'banner';
    const preparation = props.preparation;
    const total = preparation?.total;
    const progressLabel = total === undefined
        ? t('externalSessions.browseIndexing')
        : t('externalSessions.browseIndexingProgress', {
            scanned: preparation!.scanned,
            total,
        });
    const skeleton = isBanner ? null : Array.from({ length: 7 }, (_, index) => (
        <SelectionListSkeletonRow
            key={index}
            index={index}
            testID={`direct-session-candidates:loading:row-${index}`}
        />
    ));
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
    const fraction = total !== undefined && total > 0
        ? Math.max(0, Math.min(1, preparation.scanned / total))
        : null;
    return (
        <View style={isBanner ? styles.indexing : [styles.indexing, styles.loading]}>
            <View
                accessibilityElementsHidden={fraction !== null}
                importantForAccessibility={fraction !== null ? 'no-hide-descendants' : undefined}
                {...(fraction !== null ? ({ 'aria-hidden': true } as Record<string, unknown>) : {})}
            >
                <MeterBar tone="neutral" fillFraction={fraction ?? 0} height={2}
                    fillColor={theme.colors.text.secondary} trackColor={theme.colors.border.default} />
            </View>
            <View style={styles.indexingStatus}>
                <View
                    testID="direct-session-candidates:indexing"
                    style={styles.indexingRegion}
                    accessibilityRole="progressbar"
                    accessibilityLabel={progressLabel}
                    accessibilityValue={total === undefined ? undefined : {
                        min: 0,
                        max: total,
                        now: preparation.scanned,
                    }}
                    {...({ role: 'progressbar' } as Record<string, unknown>)}
                >
                    {total === undefined ? (
                        <View
                            accessibilityElementsHidden
                            importantForAccessibility="no-hide-descendants"
                            {...({ 'aria-hidden': true } as Record<string, unknown>)}
                        >
                            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                        </View>
                    ) : null}
                    <Text style={[styles.indexingLabel, Typography.tabular()]} numberOfLines={1}>
                        {total === undefined
                            ? t('externalSessions.browseIndexing')
                            : `${t('externalSessions.browseIndexing')} · ${progressLabel}`}
                    </Text>
                </View>
                {props.onCancelPreparation ? (
                    <RoundButton
                        testID="direct-session-candidates:indexing:cancel"
                        size="small"
                        display="inverted"
                        title={t('externalSessions.browseIndexingStop')}
                        accessibilityLabel={t('externalSessions.browseIndexingStop')}
                        onPress={props.onCancelPreparation}
                    />
                ) : null}
            </View>
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
    /** The machine's Home has not answered with its machine list: not known to be gone. */
    | Readonly<{ kind: 'unreachable'; homeName: string | null; onChooseMachine?: () => void }>
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
    browseCapabilityAvailable?: boolean;
    /** The machine scope; see {@link ExternalSessionBrowseScope}. Absent means ready. */
    scope?: ExternalSessionBrowseScope;
    /** The browser's scope (machine, Agent, source) as SelectionList filters beside the search band. */
    filters?: ReadonlyArray<SelectionListFilter>;
    /** Controls that trail the search band after the filters (the ⋯ menu, close). */
    bandTrailing?: React.ReactNode;
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
    const interactionStateRef = React.useRef({
        candidateActionsDisabled,
        linkingSessionId: props.linkingSessionId,
        deletingCandidateKey: props.deletingCandidateKey ?? null,
        candidateDeleteSupported,
        offline,
        interaction,
        searchTarget,
        searchQuery: props.searchQuery,
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
            emptyStateLabel: t(isContentSearch ? 'common.loading' : hasSearchQuery
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
    const contentCoverageAnnouncement = isContentSearch && props.candidates.length > 0 && props.contentCoverage !== 'complete'
        ? t('externalSessions.browseContentPartial')
        : null;
    const incompleteAnnouncement = [searchIncompleteAnnouncement, contentCoverageAnnouncement, annotationsIncompleteAnnouncement]
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
    // The visible loading state is a live region on web/Android; iOS mirrors it.
    // An index build is announced by the hidden status below instead, because its
    // visible progress deliberately is not live (count ticks must not speak).
    const loadingAnnouncement = !props.preparation
        && !hasLoadedRows && (projectionPhase === 'loading' || props.loading || props.loadingMore)
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
    const scope = props.scope ?? READY_SCOPE;
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
    ) : scope.kind === 'unreachable' ? (
        <SurfaceStateCard
            testID="direct-session-candidates:home-unreachable"
            kind="unavailable"
            iconName="cloud-slash"
            accessibilitySemantics="status"
            title={scope.homeName
                ? t('settingsPlugins.targetSelection.unreachableHome', { home: scope.homeName })
                : t('settingsPlugins.targetSelection.unreachableThisHome')}
            reason={t('externalSessions.browseHomeUnreachableBody')}
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
            title={t('externalSessions.browseCantReachTitle', { machine: machineInSentence })}
            reason={t('externalSessions.browseCantReachBody')}
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
    ) : isContentSearch && props.contentSearchSubmitted !== true ? (
        <EmptyState
            layout="line"
            testID="direct-session-candidates:content-unsearched"
            title={t('externalSessions.browseContentSearchPrompt')}
        />
    ) : props.loading || props.loadingMore || props.preparation !== null ? (
        <BrowseLoadingState
            preparation={props.preparation}
            onCancelPreparation={props.onCancelPreparation}
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
            title={t('externalSessions.browseErrorTitle')}
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
    const hasStatusRows = indexingBannerVisible
        || (isContentSearch && hasLoadedRows && props.contentCoverage !== 'complete')
        || (!isContentSearch && props.candidates.length > 0 && props.searchIncomplete === true)
        || showAnnotationsIncomplete;
    const statusRows = hasStatusRows ? (
        <View testID="direct-session-candidates-status">
            {isContentSearch && hasLoadedRows && props.contentCoverage !== 'complete' ? (
                <Text
                    testID="direct-session-candidates-content-partial"
                    style={styles.searchIncomplete}
                    accessibilityLiveRegion="polite"
                >
                    {t('externalSessions.browseContentPartial')}
                </Text>
            ) : null}
            {indexingBannerVisible ? (
                <BrowseLoadingState
                    placement="banner"
                    preparation={props.preparation}
                    onCancelPreparation={props.onCancelPreparation}
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
        <View testID="direct-session-candidates-root" style={styles.root}>
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
                inputAccessoryRow={statusRows}
                inputSuffix={isContentSearch || props.searchAugmenting || props.bandTrailing ? (
                    <View style={styles.searchSuffix}>
                        {isContentSearch ? (
                            <RoundButton
                                testID="direct-session-candidates-content-submit"
                                size="small"
                                title={t(props.loading || props.loadingMore ? 'externalSessions.browseIndexingStop' : 'externalSessions.browseContentSubmit')}
                                disabled={props.contentSearchSupported !== true
                                    || (props.loading || props.loadingMore ? !props.onCancelPreparation : !props.onSearchSubmit || !props.searchQuery.trim())}
                                onPress={() => {
                                    if (props.loading || props.loadingMore) props.onCancelPreparation?.();
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
                    onEndReached: props.onLoadMore,
                    onRetry: props.onRetry,
                    loadingLabel: t('common.loading'),
                    moreLabel: t('common.more'),
                    retryLabel: t('common.retry'),
                    endReachedLabel: t('common.done'),
                } : undefined}
            />
        </View>
    );
});
