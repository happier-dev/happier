import * as React from 'react';
import { happierPageTextMetrics, type HappierSceneId } from '@happier-dev/plugin-ui/presentation';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { UsageNoticeInboxRow } from '@/components/inbox/cards/UsageNoticeInboxRow';
import { InboxReadySessionRow } from '@/components/inbox/InboxReadySessionRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { formatAutomationRunCauseLabel, formatAutomationRunStateLabel } from '@/components/automations/list/automationListFormatting';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { useAutomation } from '@/sync/domains/state/storage';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { Typography } from '@/constants/Typography';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { isFocusedInboxApproval, readInboxApprovalServerId, type InboxItemFocus } from './inboxItemFocus';
import { t } from '@/text';
import { trackFriendsProfileView } from '@/track';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';

import { ActionOperationRows } from './actionOperations/ActionOperationLedger';
import { openActionOperation } from './actionOperations/actionOperationPresentationRuntime';
import { InboxSection } from './InboxSection';
import { countInboxUpdates, hasInboxNeedsYouRows } from './inboxCounts';
import { presentInboxSessionStatus } from './workGroups/InboxWorkItemRow';
import { buildInboxSessionContextLine } from './workGroups/inboxSessionContextLine';
import { groupInboxWorkSheets, InboxWorkGroupSection } from './workGroups/InboxWorkGroupSection';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type InboxView = 'needs_you' | 'updates';

const OTHER_GROUP = Object.freeze<InboxWorkGroup>({ key: 'other', root: { kind: 'other' }, items: [] });

const BoundApprovalRow = React.memo(function BoundApprovalRow(props: Readonly<{
    artifact: DecryptedArtifact; selected: boolean; showHome: boolean; inlineActionLabel?: string;
    navigate: (route: string) => void; onSelectItem?: (focus: InboxItemFocus) => void;
}>) {
    const serverId = readInboxApprovalServerId(props.artifact.header as Readonly<Record<string, unknown>> | undefined);
    const { navigate, onSelectItem } = props;
    const id = props.artifact.id;
    const open = React.useCallback(() => onSelectItem ? onSelectItem({ kind: 'approval', serverId, id })
        : navigate(`/inbox/approvals/${encodeURIComponent(id)}${serverId ? `?serverId=${encodeURIComponent(serverId)}` : ''}`), [id, navigate, onSelectItem, serverId]);
    return <ApprovalInboxCard artifact={props.artifact} selected={props.selected} showHome={props.showHome}
        inlineActionLabel={props.inlineActionLabel} onPress={open} />;
});

const BoundReadyRow = React.memo(function BoundReadyRow(props: Readonly<{
    session: Session; serverId: string | null; identityDisplay: SessionListIdentityDisplay; title: string; subtitle?: string;
    route?: string; pending: boolean; navigate: (route: string) => void; markRead: InboxModel['markRead'];
}>) {
    const { route, navigate, markRead, serverId } = props;
    const sessionId = props.session.id;
    const open = React.useCallback(() => { if (route) navigate(route); }, [navigate, route]);
    const mark = React.useCallback(() => markRead([{ key: buildServerScopedSessionKey(sessionId, serverId), sessionId, serverId, readState: 'unread' }]), [markRead, serverId, sessionId]);
    const nowMs = React.useMemo(() => Date.now(), [props.session]);
    const status = presentInboxSessionStatus(props.session, nowMs);
    return <InboxReadySessionRow session={props.session} identityDisplay={props.identityDisplay}
        connected={getSessionStatus(props.session, nowMs, { workingTextMode: 'static' }).isConnected} sessionId={sessionId} serverId={serverId}
        title={props.title} subtitle={props.subtitle} statusWord={status.word} statusTone={status.tone} pending={props.pending} onOpen={open} onMarkRead={mark} />;
});

/**
 * The one non-scrolling Inbox body used by both screen and anchored popover.
 * Each host owns exactly one scroll container and supplies a callback that
 * closes transient chrome before any navigation begins.
 *
 * "Needs you" is grouped by the work each item belongs to (ORC R-10, lab `inbox-I1`); "Updates"
 * holds what finished and people. The popover shows the grouped needs-you rows and says how many
 * more wait in the Inbox (lab `inbox-I2`).
 */
export const InboxContent = React.memo(function InboxContent(props: Readonly<{
    model: InboxModel;
    onBeforeNavigate?: () => void;
    /** Popover only: opens the full Inbox from the "N more" lines. */
    onOpenInbox?: () => void;
    presentation?: 'screen' | 'popover';
    view?: InboxView;
    /** The item the person came to see (`/inbox?item=`): its row is drawn selected. */
    focusedItem?: InboxItemFocus | null;
    /**
     * Beside the Inbox's detail pane (lab `inbox-I1`) a row selects its item there instead of
     * leaving the Inbox; without it (phones, the popover) a row opens its item's own page.
     */
    onSelectItem?: (focus: InboxItemFocus) => void;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { model } = props;
    const presentation = props.presentation ?? 'screen';
    const page = presentation === 'screen';
    const view: InboxView = page ? (props.view ?? 'needs_you') : 'needs_you';
    const sectionSurface = page ? 'page' : 'flat';
    const identityDisplay = useSessionListIdentityDisplay();

    const navigate = React.useCallback((route: string | InboxModel['automationAttentionItems'][number]['route']) => {
        props.onBeforeNavigate?.();
        router.push(route as never);
    }, [props.onBeforeNavigate, router]);
    const openOperation = React.useCallback((operation: Parameters<typeof openActionOperation>[0]) => {
        props.onBeforeNavigate?.();
        openActionOperation(operation);
    }, [props.onBeforeNavigate]);
    const operationsByProjection = React.useMemo(() => {
        type OperationEntry = InboxModel['actionOperationEntries'][number];
        const entryByProjection = new Map<OperationEntry['operation'], OperationEntry>();
        for (const entry of model.actionOperationEntries) entryByProjection.set(entry.operation, entry);
        return entryByProjection;
    }, [model.actionOperationEntries]);
    const operations = React.useMemo(
        () => model.actionOperationEntries.map((entry) => entry.operation),
        [model.actionOperationEntries],
    );
    const resolveOperation = React.useCallback((operation: InboxModel['actionOperationEntries'][number]['operation']) => {
        const entry = operationsByProjection.get(operation);
        if (entry) model.resolveActionOperation(entry);
    }, [model.resolveActionOperation, operationsByProjection]);
    const openUsage = React.useCallback(() => navigate('/settings/usage'), [navigate]);

    const rootGroups = React.useMemo(
        () => groupInboxWorkSheets(model.workGroups.filter((group) => group.root.kind !== 'other')),
        [model.workGroups],
    );
    const otherGroup = model.workGroups.find((group) => group.root.kind === 'other') ?? OTHER_GROUP;
    const otherExtraCount = model.openApprovals.length + model.actionOperationEntries.length;
    const hasOther = otherGroup.items.length > 0 || otherExtraCount > 0;
    // The popover keeps "Other sessions" to one line when work roots are shown (lab `inbox-I2`);
    // with no roots, the other rows are the popover's content.
    const otherInline = page || rootGroups.length === 0;
    // Emptiness is about rows, counted or parked (a snoozed row is drawn but asks for nothing).
    const needsYouEmpty = !hasInboxNeedsYouRows(model);
    const updatesCount = countInboxUpdates(model);
    const workflowUnavailable = model.workflowAttention.available
        && (model.workflowAttention.phase === 'failed' || model.workflowAttention.refreshFailed);
    const workflowStale = workflowUnavailable && model.workflowAttention.phase === 'loaded'
        && model.workflowAttention.runIds.length > 0;
    const automationUnavailable = model.automationAttention.available
        && (model.automationAttention.phase === 'failed' || model.automationAttention.refreshFailed);
    const automationStale = automationUnavailable && model.automationAttention.phase === 'loaded'
        && model.automationAttention.runIds.length > 0;

    const otherExtra = (
        <>
            {model.openApprovals.map((artifact) => {
                const approvalServerId = readInboxApprovalServerId(artifact.header as Readonly<Record<string, unknown>> | undefined);
                return (
                    <BoundApprovalRow
                        key={artifact.id}
                        artifact={artifact}
                        selected={isFocusedInboxApproval(artifact.id, approvalServerId, props.focusedItem ?? null)}
                        navigate={navigate}
                        onSelectItem={props.onSelectItem}
                        showHome={model.spansHomes}
                        inlineActionLabel={page ? undefined : t('inbox.work.rows.review')}
                    />
                );
            })}
            {operations.length > 0 ? (
                <ActionOperationRows
                    operations={operations}
                    presentation="inbox"
                    onOpenOperation={openOperation}
                    onDismissOperation={resolveOperation}
                />
            ) : null}
        </>
    );

    const markAllRead = () => { void model.markRead(model.sessionPresentation.markAllReadTargets); };
    const markAllReadAction = page ? (
        <SectionActionButton
            testID="inbox.ready.mark_all_read"
            title={t('inbox.markAllRead')}
            icon="checks"
            disabled={model.markAllPending}
            onPress={markAllRead}
        />
    ) : (
        <Pressable
            testID="inbox.ready.mark_all_read"
            accessibilityRole="button"
            accessibilityLabel={t('inbox.markAllRead')}
            accessibilityState={{ disabled: model.markAllPending }}
            disabled={model.markAllPending}
            hitSlop={Platform.select({ ios: 15, default: 17 })}
            onPress={markAllRead}
            style={({ pressed }) => [
                styles.sectionAction,
                pressed ? styles.sectionActionPressed : null,
                model.markAllPending ? styles.sectionActionDisabled : null,
            ]}
        >
            <Text style={styles.sectionActionLabel}>{t('inbox.markAllRead')}</Text>
        </Pressable>
    );

    const renderEmpty = (title: string, subtitle: string, scene: HappierSceneId) => (page ? (
        // A sheetless page section, so the state sits in the page's content column.
        <ItemGroup surface="none">
            <EmptyState testID="inbox.empty" layout="page" scene={scene} title={title} subtitle={subtitle} />
        </ItemGroup>
    ) : (
        <View style={styles.emptyContainer}>
            <EmptyState testID="inbox.empty" scene={scene} title={title} subtitle={subtitle} />
        </View>
    ));

    const loading = model.isLoading && !model.hasPrimaryAttention;

    return (
        <View testID="inbox.content" style={styles.container}>
            {view === 'needs_you' ? (
                <>
                    {workflowStale ? (
                        <View style={page ? styles.freshnessPage : styles.freshnessFlat}>
                            <SurfaceFreshnessLine
                                testID="inbox.workflow_stale"
                                asOf={model.workflowAttention.knownAt}
                                reason={t('inbox.work.stale.reason')}
                                action={{ label: t('inbox.work.stale.retry'), onPress: model.workflowAttention.retry }}
                            />
                        </View>
                    ) : workflowUnavailable ? (
                        <View style={page ? styles.freshnessPage : styles.freshnessFlat}>
                            <SurfaceStateCard
                                testID="inbox.workflow_unavailable"
                                kind="unavailable"
                                size="line"
                                title={t('workflows.destination.history.loadFailedTitle')}
                                reason={t('inbox.work.stale.reason')}
                                action={{ label: t('inbox.work.stale.retry'), onPress: model.workflowAttention.retry, testID: 'inbox.workflow_retry' }}
                            />
                        </View>
                    ) : null}

                    {automationStale ? (
                        <View style={page ? styles.freshnessPage : styles.freshnessFlat}>
                            <SurfaceFreshnessLine testID="inbox.automation_stale"
                                asOf={model.automationAttention.knownAt} reason={t('inbox.work.stale.reason')}
                                action={{ label: t('common.retry'), onPress: model.automationAttention.retry }} />
                        </View>
                    ) : automationUnavailable ? (
                        <View style={page ? styles.freshnessPage : styles.freshnessFlat}>
                            <SurfaceStateCard testID="inbox.automation_unavailable" kind="unavailable" size="line"
                                title={t('automations.session.failedToLoad')} reason={t('inbox.work.stale.reason')}
                                action={{ label: t('common.retry'), onPress: model.automationAttention.retry, testID: 'inbox.automation_retry' }} />
                        </View>
                    ) : null}

                    {model.automationAttentionItems.length > 0 || model.automationAttention.hasMore ? (
                        <InboxSection testID="inbox.section.automations" title={t('navigation.automations')} surface={sectionSurface}>
                            {model.automationAttentionItems.map(item => (
                                <AutomationAttentionRow key={item.key} item={item} onOpen={() => navigate(item.route)} />
                            ))}
                            {model.automationAttention.hasMore ? (
                                <SectionActionButton testID="inbox.automation_more" icon="caret-down"
                                    title={model.automationAttention.loadMoreFailed ? t('common.retry') : t('automations.detail.loadMoreRuns')}
                                    disabled={model.automationAttention.loadingMore} onPress={model.automationAttention.loadMore} />
                            ) : null}
                        </InboxSection>
                    ) : null}

                    {rootGroups.map((group, index) => (
                        <InboxWorkGroupSection
                            key={group.key}
                            group={group}
                            model={model}
                            identityDisplay={identityDisplay}
                            presentation={presentation}
                            spacingBefore={index > 0 ? 'separated' : undefined}
                            navigate={navigate}
                            onBeforeNavigate={props.onBeforeNavigate}
                            focusedItem={props.focusedItem}
                            onSelectItem={props.onSelectItem}
                        />
                    ))}

                    {hasOther && otherInline ? (
                        <InboxWorkGroupSection
                            group={otherGroup}
                            model={model}
                            identityDisplay={identityDisplay}
                            presentation={presentation}
                            navigate={navigate}
                            onBeforeNavigate={props.onBeforeNavigate}
                            focusedItem={props.focusedItem}
                            onSelectItem={props.onSelectItem}
                            extra={otherExtra}
                        />
                    ) : null}

                    {model.openUsageNotices.length > 0 ? (
                        <InboxSection testID="inbox.section.usage" title={t('settings.usage')}
                            surface={sectionSurface} spacingBefore={rootGroups.length > 0 || hasOther ? 'separated' : undefined}>
                            {model.openUsageNotices.map((entry) => (
                                <UsageNoticeInboxRow key={entry.artifact.id} entry={entry}
                                    onOpen={openUsage}
                                    onDismiss={model.dismissUsageNotice} />
                            ))}
                        </InboxSection>
                    ) : null}

                    {!page && ((hasOther && !otherInline) || updatesCount > 0) ? (
                        <View style={rootGroups.length > 0 ? styles.moreLines : undefined}>
                            {hasOther && !otherInline ? (
                                <Pressable
                                    testID="inbox.popover.more_other"
                                    accessibilityRole="button"
                                    onPress={props.onOpenInbox}
                                    style={({ pressed }) => [styles.moreLine, pressed ? styles.sectionActionPressed : null]}
                                >
                                    <Text style={styles.moreLabel}>
                                        {t('inbox.work.popover.moreInOther', { count: otherGroup.items.length + otherExtraCount })}
                                    </Text>
                                    <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                                </Pressable>
                            ) : null}
                            {updatesCount > 0 ? (
                                <Pressable
                                    testID="inbox.popover.updates"
                                    accessibilityRole="button"
                                    onPress={props.onOpenInbox}
                                    style={({ pressed }) => [styles.moreLine, pressed ? styles.sectionActionPressed : null]}
                                >
                                    <Text style={styles.moreLabel}>{t('inbox.work.popover.updates', { count: updatesCount })}</Text>
                                    <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                        </View>
                    ) : null}

                    {model.showCaughtUp && !automationUnavailable && needsYouEmpty && page
                        // Nothing anywhere: the page's calm caught-up state.
                        ? renderEmpty(t('inbox.emptyTitle'), t('inbox.emptyDescription'), 'inboxZero')
                        : !model.isLoading && !workflowUnavailable && !automationUnavailable && needsYouEmpty && (page || updatesCount === 0)
                            ? renderEmpty(t('inbox.work.empty.title'), t('inbox.work.empty.description'), 'inboxZero')
                            : null}
                </>
            ) : (
                <>
                    {model.sessionPresentation.readySessions.length > 0 ? (
                        <InboxSection
                            testID="inbox.section.ready"
                            title={t('inbox.readySessions')}
                            surface={sectionSurface}
                            rightAccessory={model.sessionPresentation.markAllReadTargets.length > 0 ? markAllReadAction : undefined}
                        >
                            {model.sessionPresentation.readySessions.map((candidate) => {
                                const serverId = candidate.address?.serverId ?? candidate.serverId ?? null;
                                const target = model.targetBySessionAddress.get(
                                    buildServerScopedSessionKey(candidate.sessionId, serverId),
                                );
                                if (!target) return null;
                                return (
                                    <BoundReadyRow
                                        key={target.key}
                                        session={candidate.session}
                                        identityDisplay={identityDisplay}
                                        serverId={serverId}
                                        title={candidate.title}
                                        subtitle={buildInboxSessionContextLine(candidate, { showHome: model.spansHomes, showNeed: false })}
                                        pending={model.pendingReadKeys.has(target.key)}
                                        route={candidate.route}
                                        navigate={navigate}
                                        markRead={model.markRead}
                                    />
                                );
                            })}
                        </InboxSection>
                    ) : null}

                    {model.friendRequests.length > 0 ? (
                        <InboxSection
                            testID="inbox.section.friends"
                            title={t('inbox.friendRequests')}
                            spacingBefore={model.sessionPresentation.readySessions.length > 0 ? 'separated' : undefined}
                            surface={sectionSurface}
                        >
                            {model.friendRequests.map((friend) => (
                                <UserCard
                                    key={friend.id}
                                    user={friend}
                                    density="compact"
                                    onPress={() => {
                                        trackFriendsProfileView();
                                        navigate(`/user/${friend.id}`);
                                    }}
                                />
                            ))}
                        </InboxSection>
                    ) : null}

                    {!loading && updatesCount === 0
                        ? renderEmpty(t('inbox.work.updatesEmpty.title'), t('inbox.work.updatesEmpty.description'), 'agentFinished')
                        : null}
                </>
            )}
        </View>
    );
});

function AutomationAttentionRow(props: Readonly<{
    item: InboxModel['automationAttentionItems'][number]; onOpen: () => void;
}>) {
    const { run } = props.item;
    const automation = useAutomation(run.automationId);
    const state = formatAutomationRunStateLabel(run.state);
    const cause = formatAutomationRunCauseLabel(run.cause);
    return <Item testID={`inbox.automation_run.${run.id}`} title={automation?.name ?? state}
        subtitle={automation?.name ? `${state} · ${cause}` : cause}
        detail={formatShortRelativeTime(run.finishedAt ?? run.startedAt ?? run.createdAt)}
        icon={<Icon name="timer" size={16} />} density="compact" onPress={props.onOpen} />;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        flexGrow: 1,
        paddingBottom: 14,
    },
    emptyContainer: {
        flexGrow: 1,
        minHeight: 240,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 40,
    },
    loadingContainer: {
        flexGrow: 1,
        minHeight: 240,
        alignItems: 'center',
        justifyContent: 'center',
    },
    freshnessPage: {
        paddingTop: 8,
    },
    freshnessFlat: {
        paddingHorizontal: 12,
        paddingTop: 6,
    },
    moreLines: {
        marginTop: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.surface,
    },
    // A line that opens the Inbox: its words, then the chevron every other opener here carries.
    moreLine: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        paddingLeft: 16,
        paddingRight: 12,
    },
    moreLabel: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
    sectionAction: {
        height: 14,
        justifyContent: 'center',
        paddingLeft: 10,
    },
    sectionActionPressed: {
        opacity: motionTokens.press.opacity,
    },
    sectionActionDisabled: {
        opacity: 0.42,
    },
    sectionActionLabel: {
        fontSize: 11,
        lineHeight: 14,
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
}));
