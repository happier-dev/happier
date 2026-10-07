import * as React from 'react';
import { happierPageTextMetrics, type HappierSceneId } from '@happier-dev/plugin-ui/presentation';
import { Platform, Pressable, View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ApprovalInboxCard } from '@/components/inbox/cards/ApprovalInboxCard';
import { InboxReadySessionRow } from '@/components/inbox/InboxReadySessionRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { UserCard } from '@/components/ui/cards/UserCard';
import { Typography } from '@/constants/Typography';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { InboxItemFocus } from './inboxItemFocus';
import { t } from '@/text';
import { trackFriendsProfileView } from '@/track';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import { useSessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import type { InboxWorkGroup } from '@/activity/presentation/buildInboxWorkGroups';

import { ActionOperationRows } from './actionOperations/ActionOperationLedger';
import { openActionOperation } from './actionOperations/actionOperationPresentationRuntime';
import { InboxSection } from './InboxSection';
import { countInboxNeedsYou, countInboxUpdates } from './inboxCounts';
import { presentInboxSessionStatus } from './workGroups/InboxWorkItemRow';
import { buildInboxSessionContextLine } from './workGroups/inboxSessionContextLine';
import { InboxWorkGroupSection } from './workGroups/InboxWorkGroupSection';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export type InboxView = 'needs_you' | 'updates';

const OTHER_GROUP = Object.freeze<InboxWorkGroup>({ key: 'other', root: { kind: 'other' }, items: [] });

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
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { model } = props;
    const presentation = props.presentation ?? 'screen';
    const page = presentation === 'screen';
    const view: InboxView = page ? (props.view ?? 'needs_you') : 'needs_you';
    const sectionSurface = page ? 'page' : 'flat';
    const identityDisplay = useSessionListIdentityDisplay();
    const nowMs = Date.now();

    const navigate = React.useCallback((route: string) => {
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
    }, [model, operationsByProjection]);

    const rootGroups = model.workGroups.filter((group) => group.root.kind !== 'other');
    const otherGroup = model.workGroups.find((group) => group.root.kind === 'other') ?? OTHER_GROUP;
    const otherExtraCount = model.openApprovals.length + model.actionOperationEntries.length;
    const hasOther = otherGroup.items.length > 0 || otherExtraCount > 0;
    // The popover keeps "Other sessions" to one line when work roots are shown (lab `inbox-I2`);
    // with no roots, the other rows are the popover's content.
    const otherInline = page || rootGroups.length === 0;
    const needsYouCount = countInboxNeedsYou(model);
    const updatesCount = countInboxUpdates(model);
    const workflowUnavailable = model.workflowAttention.available
        && (model.workflowAttention.phase === 'failed' || model.workflowAttention.refreshFailed);
    const workflowStale = workflowUnavailable && model.workflowAttention.phase === 'loaded'
        && model.workflowAttention.runIds.length > 0;

    const otherExtra = (
        <>
            {model.openApprovals.map((artifact) => {
                const approvalServerId = typeof artifact.header?.serverIdentityId === 'string'
                    ? artifact.header.serverIdentityId.trim()
                    : typeof artifact.header?.serverId === 'string'
                        ? artifact.header.serverId.trim()
                        : '';
                const approvalHref = `/inbox/approvals/${encodeURIComponent(artifact.id)}${approvalServerId
                    ? `?serverId=${encodeURIComponent(approvalServerId)}`
                    : ''}`;
                return (
                    <ApprovalInboxCard
                        key={artifact.id}
                        artifact={artifact}
                        onPress={() => navigate(approvalHref)}
                        audienceScope={typeof artifact.header?.serverId === 'string'
                            ? model.source.audienceScopes?.get(artifact.header.serverId.trim())
                            : undefined}
                        workspaceRefs={model.source.workspaceRefsV1 ?? []}
                        workspacePathDisplayModeV1={model.source.workspacePathDisplayModeV1}
                        density="compact"
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

                    {rootGroups.map((group, index) => (
                        <InboxWorkGroupSection
                            key={group.key}
                            group={group}
                            model={model}
                            identityDisplay={identityDisplay}
                            nowMs={nowMs}
                            presentation={presentation}
                            spacingBefore={index > 0 ? 'separated' : undefined}
                            navigate={navigate}
                            onBeforeNavigate={props.onBeforeNavigate}
                            focusedItem={props.focusedItem}
                        />
                    ))}

                    {hasOther && otherInline ? (
                        <InboxWorkGroupSection
                            group={otherGroup}
                            model={model}
                            identityDisplay={identityDisplay}
                            nowMs={nowMs}
                            presentation={presentation}
                            navigate={navigate}
                            onBeforeNavigate={props.onBeforeNavigate}
                            focusedItem={props.focusedItem}
                            extra={otherExtra}
                        />
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
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <ActivitySpinner size="large" color={theme.colors.text.secondary} />
                        </View>
                    ) : null}

                    {!model.isLoading && !workflowUnavailable && needsYouCount === 0 && page && updatesCount === 0
                        // Nothing anywhere: the page's calm caught-up state.
                        ? renderEmpty(t('inbox.emptyTitle'), t('inbox.emptyDescription'), 'inboxZero')
                        : !model.isLoading && !workflowUnavailable && needsYouCount === 0 && (page || updatesCount === 0)
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
                                const status = presentInboxSessionStatus(candidate.session, nowMs);
                                return (
                                    <InboxReadySessionRow
                                        key={target.key}
                                        session={candidate.session}
                                        identityDisplay={identityDisplay}
                                        connected={getSessionStatus(candidate.session, nowMs, { workingTextMode: 'static' }).isConnected}
                                        sessionId={candidate.sessionId}
                                        serverId={serverId}
                                        title={candidate.title}
                                        subtitle={buildInboxSessionContextLine(candidate)}
                                        statusWord={status.word}
                                        statusTone={status.tone}
                                        pending={model.pendingReadKeys.has(target.key)}
                                        onOpen={() => {
                                            if (candidate.route) navigate(candidate.route);
                                        }}
                                        onMarkRead={() => model.markRead([target])}
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
    moreLine: {
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: 16,
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
