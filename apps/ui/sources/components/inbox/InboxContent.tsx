import * as React from 'react';
import type { MachineVitalsNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { happierPageTextMetrics, type HappierSceneId } from '@happier-dev/plugin-ui/presentation';
import { Platform, Pressable, View } from 'react-native';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Modal } from '@/modal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { UsageNoticeInboxRow } from '@/components/inbox/cards/UsageNoticeInboxRow';
import { MachineVitalsNoticeInboxRow, readMachineVitalsNotice } from '@/components/inbox/cards/MachineVitalsNoticeInboxRow';
import { InboxReadySessionRow } from '@/components/inbox/InboxReadySessionRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { Typography } from '@/constants/Typography';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import { type InboxItemFocus } from './inboxItemFocus';
import { t } from '@/text';
import { trackFriendsProfileView } from '@/track';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';

import { ActionOperationRows } from './actionOperations/ActionOperationLedger';
import { openActionOperation } from './actionOperations/actionOperationPresentationRuntime';
import { InboxSection } from './InboxSection';
import { countInboxUpdates, hasInboxNeedsYouRows } from './inboxCounts';
import { InboxWorkItemRow, presentInboxSessionStatus } from './workGroups/InboxWorkItemRow';
import { buildInboxSessionContextLine } from './workGroups/inboxSessionContextLine';
import { createInboxItemRoute, isFocusedInboxWorkItem } from './inboxItemFocus';
import { getInboxNeedsYouItemTypes, selectInboxItemsForView, type InboxItem, type InboxItemType, type InboxItemView } from './inboxItems';
import { InboxWorkRow } from './InboxWorkRow';
import { InboxPluginSessionLines } from './InboxPluginSessionLines';
import type { InboxPluginSessionRow } from './inboxItemProjection';
import { InboxRelativeTime } from './InboxRelativeTime';
import type { InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';
import type { IconName } from '@/components/ui/icons/Icon';
import { useIsTablet } from '@/utils/platform/responsive';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { type SessionPresentationRecord,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type InboxView = InboxItemView;

const ITEM_MARKS: Readonly<Record<InboxItemType, IconName>> = {
    approval: 'shield-check', decision: 'question', blocked: 'pause-circle', update: 'bell', mention: 'at',
};

/** Needs you reads by what is asked of the person (lab P4): approvals, then decisions, then what is blocked. */
const NEEDS_YOU_TYPES = getInboxNeedsYouItemTypes().map(type => ({ type, icon: ITEM_MARKS[type], attention: type !== 'blocked' }));

const BoundReadyRow = React.memo(function BoundReadyRow(props: Readonly<{
    session: SessionPresentationRecord; presentationSource?: SessionListPresentationSource;
    serverId: string | null; identityDisplay: SessionListIdentityDisplay; title: string; subtitle?: string;
    route?: string; pending: boolean; navigate: (route: string) => void; markRead: InboxModel['markRead'];
    pluginSessionRows?: readonly InboxPluginSessionRow[]; invokePluginSessionControl?: InboxModel['invokePluginSessionControl'];
}>) {
    const { route, navigate, markRead, serverId } = props;
    const sessionId = props.session.id;
    const open = React.useCallback(() => { if (route) navigate(route); }, [navigate, route]);
    const mark = React.useCallback(() => markRead([{ key: buildServerScopedSessionKey(sessionId, serverId), sessionId, serverId, readState: 'unread' }]), [markRead, serverId, sessionId]);
    const nowMs = React.useMemo(() => Date.now(), [props.session, props.presentationSource]);
    const status = presentInboxSessionStatus(props.session, nowMs, props.presentationSource);
    return <InboxReadySessionRow session={props.session} presentationSource={props.presentationSource} identityDisplay={props.identityDisplay}
        connected={getSessionStatus(props.session, nowMs, { presentationSource: props.presentationSource }).isConnected} sessionId={sessionId} serverId={serverId}
        title={props.title} subtitle={props.subtitle} statusWord={status.word} statusTone={status.tone} pending={props.pending} onOpen={open} onMarkRead={mark}
        pluginSessionRows={props.pluginSessionRows} invokePluginSessionControl={props.invokePluginSessionControl} />;
});

/**
 * A row for an item no work owner draws (a stored notice, a Discussion message): the same Work row
 * anatomy as every other Inbox row (lab P4: one row for everything), opening the item's own page.
 */
const InboxItemRow = React.memo(function InboxItemRow(props: Readonly<{
    item: InboxItem; selected: boolean; narrow: boolean; showDivider?: boolean;
    navigate: (route: string) => void; onSelectItem?: (focus: InboxItemFocus) => void;
    markOpened: InboxModel['markItemOpened'];
    /** A stored notice's one quick action, the same Dismiss every Inbox notice row carries. */
    dismissNotice: (item: InboxItem) => Promise<void>;
    invokePluginSessionControl: InboxModel['invokePluginSessionControl'];
}>) {
    const { theme } = useUnistyles();
    const { item, navigate, onSelectItem, markOpened, dismissNotice } = props;
    // Lab P4 row: where it comes from, the title, what it says, and who. The excerpt is the detail
    // when the item carries one; a Discussion row without it says what happened.
    const fact = item.excerpt
        ?? (item.source.kind === 'discussion'
            ? t(item.type === 'mention' ? 'inbox.work.rows.mentionedYou' : 'inbox.work.rows.newMessage')
            : item.context);
    const byline = item.author
        ? { text: item.author.isSelf ? t('session.collaboration.pane.you') : item.author.name }
        : null;
    const open = React.useCallback(async () => {
        if (onSelectItem) onSelectItem(item.focus);
        else {
            await markOpened(item);
            navigate(item.pageRoute);
        }
    }, [item, navigate, onSelectItem, markOpened]);
    const dismiss = React.useCallback(async () => {
        try { await dismissNotice(item); }
        catch { Modal.alert(t('common.error'), t('errors.unknownError')); }
    }, [dismissNotice, item]);
    // Where it comes from leads the line, unless the title already says it.
    const source = item.source.displayName && item.source.displayName !== item.title ? item.source.displayName : null;
    return <InboxWorkRow testID={item.focus.kind === 'execution_run' ? `inbox.run.${item.focus.id}` : `inbox.item.${item.key}`} title={item.title} facts={[source, fact]}
        byline={byline}
        selected={props.selected} showDivider={props.showDivider} narrow={props.narrow}
        phase={item.phase ?? (item.view === 'needs_you' ? 'attention' : 'finished')} status={item.workStatus}
        time={<InboxRelativeTime timestamp={item.createdAt} />}
        mark={<Icon name={item.focus.kind === 'execution_run' ? item.type === 'approval' ? 'hand' : 'play-circle' : ITEM_MARKS[item.type]} size={18}
            color={item.view === 'needs_you' ? theme.colors.state.attention.foreground : theme.colors.text.secondary} />}
        trailingAccessory={item.producer === 'notice' ? (
            <IconButton testID={`inbox.item.${item.key}.dismiss`} accessibilityLabel={t('inbox.actionOperations.dismiss')}
                tooltip={t('inbox.actionOperations.dismiss')} iconName="x" variant="plain" size={28}
                interactiveTargetGapPx={8}
                onPress={dismiss} />
        ) : undefined}
        belowAccessory={item.pluginSessionRows?.length ? (
            <InboxPluginSessionLines rows={item.pluginSessionRows} invoke={props.invokePluginSessionControl}
                testID={`inbox.item.${item.key}.plugin_rows`} />
        ) : undefined}
        onPress={open} />;
});

/** A worker row names its lead and its latest update from the Inbox item the model already projected. */
function readInboxItemWorker(item: InboxItem) {
    return item.reportsTo ? { leadTitle: item.reportsTo.title, headline: item.workerUpdateHeadline } : undefined;
}

type WorkRowSource = Readonly<{ item: InboxWorkItem; automationServerId: string | null }>;

/**
 * The one non-scrolling Inbox body used by both screen and anchored popover.
 * Each host owns exactly one scroll container and supplies a callback that
 * closes transient chrome before any navigation begins.
 *
 * It draws the canonical item model (`model.items`, F4) in three views (lab P4): Needs you grouped by
 * type, Updates newest first by day, and Mentions. Rows keep their owners: a session's request keeps
 * its answer card, a run its Review, an approval its card; items no work owner draws (stored notices,
 * Discussion messages) take the same Work row. The popover shows Needs you and one line to Updates.
 */
export const InboxContent = React.memo(function InboxContent(props: Readonly<{
    model: InboxModel;
    onBeforeNavigate?: () => void;
    /** Popover only: opens the full Inbox from its Updates line. */
    onOpenInbox?: () => void;
    presentation?: 'screen' | 'popover';
    view?: InboxView;
    /** The item the person came to see (`/inbox?item=`): its row is drawn selected. */
    focusedItem?: InboxItemFocus | null;
    /**
     * Beside the Inbox's detail pane a row selects its item there instead of leaving the Inbox;
     * without it (phones, the popover) a row opens its item's own page.
     */
    onSelectItem?: (focus: InboxItemFocus) => void;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { model } = props;
    const presentation = props.presentation ?? 'screen';
    const page = presentation === 'screen';
    const wide = useIsTablet();
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
    const notices = React.useMemo(() => {
        const usage: InboxModel['openUsageNotices'][number][] = [];
        const machines: { entry: InboxModel['openUsageNotices'][number]; notice: MachineVitalsNotificationV1 }[] = [];
        for (const entry of model.openUsageNotices) {
            const notice = readMachineVitalsNotice(entry);
            if (notice) machines.push({ entry, notice });
            else usage.push(entry);
        }
        return { usage, machines };
    }, [model.openUsageNotices]);

    // The work owners still draw their own rows; the item model only decides where each one sits.
    const workRows = React.useMemo(() => {
        const rows = new Map<string, WorkRowSource>();
        for (const group of model.workGroups) for (const item of group.items) {
            rows.set(item.key, { item, automationServerId: group.root.kind === 'automation' ? group.root.serverId : model.automationAttention.serverId });
        }
        return rows;
    }, [model.workGroups, model.automationAttention.serverId]);
    const readyRows = React.useMemo(() => new Map(model.sessionPresentation.readySessions.flatMap((candidate) => {
        const serverId = candidate.address?.serverId ?? candidate.serverId;
        return serverId ? [[`session:${serverId}:${candidate.sessionId}` as string, candidate] as const] : [];
    })), [model.sessionPresentation.readySessions]);
    const viewItems = React.useMemo(() => selectInboxItemsForView(model.items, view), [model.items, view]);
    const focusedRouteKey = props.focusedItem ? createInboxItemRoute(props.focusedItem).params.item : null;
    const { accountNotices, dismissAccountNotice } = model;
    const dismissNotice = React.useCallback(async (item: InboxItem) => {
        const entry = accountNotices.find((notice) => notice.artifact.id === item.source.id);
        if (entry) await dismissAccountNotice(entry);
    }, [accountNotices, dismissAccountNotice]);

    const renderRow = (item: InboxItem, index: number, count: number) => {
        const showDivider = index < count - 1;
        const work = workRows.get(item.key);
        if (work) {
            return (
                <InboxWorkItemRow
                    key={item.key}
                    item={work.item}
                    spansHomes={model.spansHomes}
                    workflowServerId={model.workflowAttention.serverId}
                    automationServerId={work.automationServerId}
                    settle={model.settle}
                    setReminder={model.setReminder}
                    identityDisplay={identityDisplay}
                    presentation={presentation}
                    navigate={navigate}
                    onBeforeNavigate={props.onBeforeNavigate}
                    focused={isFocusedInboxWorkItem(work.item, props.focusedItem ?? null, model.workflowAttention.serverId, model.automationAttention.serverId)}
                    onSelectItem={props.onSelectItem}
                    showDivider={showDivider}
                    pluginSessionRows={item.pluginSessionRows}
                    invokePluginSessionControl={model.invokePluginSessionControl}
                    reportsToTitle={item.reportsTo ? item.reportsTo.title : undefined}
                    workerUpdateHeadline={item.workerUpdateHeadline}
                />
            );
        }
        const ready = readyRows.get(item.key);
        if (ready) {
            const serverId = ready.address?.serverId ?? ready.serverId ?? null;
            const target = model.targetBySessionAddress.get(buildServerScopedSessionKey(ready.sessionId, serverId));
            if (!target) return null;
            return (
                <BoundReadyRow
                    key={item.key}
                    session={ready.session}
                    presentationSource={ready.presentationSource}
                    identityDisplay={identityDisplay}
                    serverId={serverId}
                    title={ready.title}
                    subtitle={buildInboxSessionContextLine(ready, { showHome: model.spansHomes, showNeed: false, worker: readInboxItemWorker(item) })}
                    pending={model.pendingReadKeys.has(target.key)}
                    route={ready.route}
                    navigate={navigate}
                    markRead={model.markRead}
                    pluginSessionRows={item.pluginSessionRows}
                    invokePluginSessionControl={model.invokePluginSessionControl}
                />
            );
        }
        return (
            <InboxItemRow key={item.key} item={item} narrow={!(page && wide)} showDivider={showDivider}
                selected={focusedRouteKey !== null && createInboxItemRoute(item.focus).params.item === focusedRouteKey}
                navigate={navigate} onSelectItem={props.onSelectItem} markOpened={model.markItemOpened} dismissNotice={dismissNotice}
                invokePluginSessionControl={model.invokePluginSessionControl} />
        );
    };

    const needsYouSections = React.useMemo(() => NEEDS_YOU_TYPES
        .map((entry) => ({ ...entry, items: viewItems.filter((item) => item.type === entry.type) }))
        .filter((entry) => entry.items.length > 0), [viewItems]);
    // Updates and Mentions read newest first under the day they arrived (lab P4 "Today").
    const daySections = React.useMemo(() => {
        if (view === 'needs_you') return [];
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        const today = viewItems.filter((item) => item.createdAt >= startOfToday);
        const earlier = viewItems.filter((item) => item.createdAt < startOfToday);
        return [
            { key: 'today', title: t('inbox.work.days.today'), items: today },
            { key: 'earlier', title: t('inbox.work.days.earlier'), items: earlier },
        ].filter((entry) => entry.items.length > 0);
    }, [view, viewItems]);

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
    const typeCount = (count: number) => <Text style={styles.count}>{count}</Text>;

    return (
        <View testID="inbox.content" style={styles.container}>
            {model.artifactSource.phase === 'failed' || model.artifactSource.phase === 'partial' ? (
                <View style={page ? styles.freshnessPage : styles.freshnessFlat}>
                    {model.hasPrimaryAttention ? (
                        <SurfaceFreshnessLine testID="inbox.artifacts_stale" reason={t('inbox.work.stale.reason')}
                            action={{ label: t('common.retry'), onPress: model.artifactSource.retry }} />
                    ) : (
                        <SurfaceStateCard testID="inbox.artifacts_unavailable" kind="unavailable" size="line"
                            title={t('common.error')} reason={t('inbox.work.stale.reason')}
                            action={{ label: t('common.retry'), onPress: model.artifactSource.retry, testID: 'inbox.artifacts_retry' }} />
                    )}
                </View>
            ) : null}
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

                    {needsYouSections.map((section, index) => (
                        <InboxSection
                            key={section.type}
                            testID={`inbox.type.${section.type}`}
                            title={t(`inbox.work.types.${section.type}`)}
                            surface={sectionSurface}
                            spacingBefore={index > 0 ? 'separated' : undefined}
                            leading={page ? (
                                <Icon name={section.icon} size={16}
                                    color={section.attention ? theme.colors.state.attention.foreground : theme.colors.text.secondary} />
                            ) : undefined}
                            meta={page ? typeCount(section.items.length) : undefined}
                        >
                            {section.items.map((item, rowIndex) => renderRow(item, rowIndex, section.items.length))}
                        </InboxSection>
                    ))}

                    {operations.length > 0 ? (
                        <InboxSection testID="inbox.section.operations" title={t('inbox.actionOperations.sections.needsAttention')}
                            surface={sectionSurface} spacingBefore={needsYouSections.length > 0 ? 'separated' : undefined}>
                            <ActionOperationRows
                                operations={operations}
                                presentation="inbox"
                                onOpenOperation={openOperation}
                                onDismissOperation={resolveOperation}
                            />
                        </InboxSection>
                    ) : null}

                    {model.automationAttention.hasMore ? (
                        <InboxSection testID="inbox.section.automations" title={t('navigation.automations')} surface={sectionSurface}>
                            <SectionActionButton testID="inbox.automation_more" icon="caret-down"
                                title={model.automationAttention.loadMoreFailed ? t('common.retry') : t('automations.detail.loadMoreRuns')}
                                disabled={model.automationAttention.loadingMore} onPress={model.automationAttention.loadMore} />
                        </InboxSection>
                    ) : null}

                    {!page && updatesCount > 0 ? (
                        <View style={needsYouSections.length > 0 ? styles.moreLines : undefined}>
                            <Pressable
                                testID="inbox.popover.updates"
                                accessibilityRole="button"
                                onPress={props.onOpenInbox}
                                style={({ pressed }) => [styles.moreLine, pressed ? styles.sectionActionPressed : null]}
                            >
                                <Text style={styles.moreLabel}>{t('inbox.work.popover.updates', { count: updatesCount })}</Text>
                                <Icon name="caret-right" size={14} color={theme.colors.text.tertiary} />
                            </Pressable>
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
                        : model.artifactSource.phase === 'current' && !model.isLoading && !workflowUnavailable && !automationUnavailable && needsYouEmpty && (page || updatesCount === 0)
                            ? renderEmpty(t('inbox.work.empty.title'), t('inbox.work.empty.description'), 'inboxZero')
                            : null}
                </>
            ) : (
                <>
                    {daySections.map((section, index) => (
                        <InboxSection
                            key={section.key}
                            testID={`inbox.day.${section.key}`}
                            title={section.title}
                            surface={sectionSurface}
                            spacingBefore={index > 0 ? 'separated' : undefined}
                            rightAccessory={index === 0 && view === 'updates' && model.sessionPresentation.markAllReadTargets.length > 0
                                ? markAllReadAction : undefined}
                        >
                            {section.items.map((item, rowIndex) => renderRow(item, rowIndex, section.items.length))}
                        </InboxSection>
                    ))}

                    {view === 'updates' && notices.machines.length > 0 ? (
                        <InboxSection testID="inbox.section.machines" title={t('settings.machines')}
                            surface={sectionSurface} spacingBefore={daySections.length > 0 ? 'separated' : undefined}>
                            {notices.machines.map(({ entry, notice }) => (
                                <MachineVitalsNoticeInboxRow key={entry.artifact.id} entry={entry} notice={notice}
                                    navigate={navigate}
                                    onDismiss={model.dismissUsageNotice} />
                            ))}
                        </InboxSection>
                    ) : null}

                    {view === 'updates' && notices.usage.length > 0 ? (
                        <InboxSection testID="inbox.section.usage" title={t('settings.usage')}
                            surface={sectionSurface} spacingBefore={daySections.length > 0 || notices.machines.length > 0 ? 'separated' : undefined}>
                            {notices.usage.map((entry) => (
                                <UsageNoticeInboxRow key={entry.artifact.id} entry={entry}
                                    onOpen={openUsage}
                                    onDismiss={model.dismissUsageNotice} />
                            ))}
                        </InboxSection>
                    ) : null}

                    {view === 'updates' && model.friendRequests.length > 0 ? (
                        <InboxSection
                            testID="inbox.section.friends"
                            title={t('inbox.friendRequests')}
                            spacingBefore={daySections.length > 0 || model.openUsageNotices.length > 0 ? 'separated' : undefined}
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

                    {model.artifactSource.phase === 'current' && !loading && view === 'updates' && daySections.length === 0 && model.friendRequests.length === 0 && model.openUsageNotices.length === 0
                        ? renderEmpty(t('inbox.work.updatesEmpty.title'), t('inbox.work.updatesEmpty.description'), 'agentFinished')
                        : null}
                    {model.artifactSource.phase === 'current' && !loading && view === 'mentions' && daySections.length === 0
                        ? renderEmpty(t('inbox.work.mentionsEmpty.title'), t('inbox.work.mentionsEmpty.description'), 'inboxZero')
                        : null}
                </>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        flexGrow: 1,
        paddingBottom: theme.space.s16,
    },
    emptyContainer: {
        flexGrow: 1,
        minHeight: 240,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s40,
    },
    loadingContainer: {
        flexGrow: 1,
        minHeight: 240,
        alignItems: 'center',
        justifyContent: 'center',
    },
    freshnessPage: {
        paddingTop: theme.space.s8,
    },
    freshnessFlat: {
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s6,
    },
    moreLines: {
        marginTop: theme.space.s6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.surface,
    },
    // A line that opens the Inbox: its words, then the chevron every other opener here carries.
    moreLine: {
        minHeight: 40,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
        paddingLeft: theme.space.s16,
        paddingRight: theme.space.s12,
    },
    moreLabel: {
        ...Typography.default('regular'),
        ...happierPageTextMetrics('sectionDescription'),
        color: theme.colors.text.secondary,
    },
    sectionAction: {
        height: 14,
        justifyContent: 'center',
        paddingLeft: theme.space.s10,
    },
    sectionActionPressed: {
        opacity: motionTokens.press.opacity,
    },
    sectionActionDisabled: {
        opacity: 0.42,
    },
    sectionActionLabel: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    count: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
