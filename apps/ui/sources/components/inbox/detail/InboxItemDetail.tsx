import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DestinationInstanceHost, type DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { WorkspaceDestinationBody } from '@/components/appShell/workspace/WorkspaceDestinationBody';
import { resolveDestinationRefFromHref, useCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import {
  HeaderActionsScope,
  useStackHeaderActionsClaimed,
  useStackHeaderActionsPublisher,
} from '@/components/navigation/stackHeaderActions';
import { SessionPeekDetailsView } from '@/components/sessions/work/SessionPeekDetailsView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { WorkflowRunPane } from '@/components/workflows/run/WorkflowRunPane';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useOptionalInboxModel } from '@/hooks/inbox/useInboxModel';
import { useInboxItemResolved } from '@/hooks/inbox/useInboxItemResolved';
import { InboxPluginAvailability } from '../InboxPluginAvailability';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { findInboxItemForFocus, moveInboxItem } from '../inboxItemNavigation';
import { selectInboxItemsForView } from '../inboxItems';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { useWorkRelativeTime } from '@/components/sessions/agents/presentation/agentActivityClock';
import { Modal } from '@/modal';
import { InvestigationOutcomeBanner } from './InvestigationOutcomeBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import type { AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { useMachineDisplayNamesById } from '@/sync/store/hooks';
import {
  readNoticeInvestigationSubject,
  type BoundHealthNoticeInvestigation, type NoticeInvestigationSubject,
} from './healthNoticeInvestigation';
import { InvestigationAgentActionButtons } from './InvestigationAgentActionButtons';
import { useBoundFailureInvestigation } from '@/hooks/inbox/useInvestigateFailure';
import { t } from '@/text';

import { INBOX_ITEM_DETAIL_REGISTRY, createInboxItemRoute, readInboxView, resolveInboxItemPageRoute, resolveInboxNoticeOwnPageRoute, type InboxItemFocus } from '../inboxItemFocus';

function describeOpenPage(focus: InboxItemFocus): string {
  return t(INBOX_ITEM_DETAIL_REGISTRY[focus.kind].openLabel);
}

/**
 * The detail beside the Inbox list (lab `inbox-I1`): the selected item itself, drawn by the same
 * component its own page uses, so an answer given here is the answer. The pane's two controls —
 * leave for the item's page, close — ride in that component's own header; only content that draws
 * no header (still loading, failed) gets them on a slim bar of their own.
 */
export const InboxItemDetail = React.memo(function InboxItemDetail(
  props: Readonly<{
    focus: InboxItemFocus;
    onClose: () => void;
    /** False when the item is not Inbox work here (a Board's ordinary card): nothing was answered to report. */
    resolvedReceipt?: boolean;
  }>,
) {
  const router = useRouter();
  const { focus, onClose } = props;
  const model = useOptionalInboxModel();
  const params = useLocalSearchParams<{ view?: string | string[] }>();
  const selected = model ? findInboxItemForFocus(model.items, focus) : undefined;
  const view = readInboxView(params.view) ?? selected?.view ?? 'needs_you';
  const positivelyResolved = useInboxItemResolved(focus, { sessionCandidates: model?.sessionCandidates ?? [],
    accountNotices: model?.accountNotices ?? [], isDataReady: model?.source.isDataReady ?? false,
    sessionScopes: model?.source.audienceScopes });
  // An answered attention item may still be an unread Update. The receipt describes
  // clearing this view and always requires the source owner's positive disposition.
  const resolved = props.resolvedReceipt !== false && positivelyResolved && selected?.view !== view;
  const next = resolved && model ? moveInboxItem(selectInboxItemsForView(model.items, view), selected?.key ?? null, 1) : null;
  const scopeKey = `inbox-detail:${React.useId()}`;
  const notice = focus.kind === 'notice'
    ? model?.accountNotices.find(entry => entry.artifact.id === focus.id)?.header
      ?? model?.openUsageNotices.find(entry => entry.artifact.id === focus.id)?.header : null;
  const pageRoute = resolveInboxItemPageRoute(focus, { notice });
  // A notice that points nowhere is its own content: the pane is its page, so there is nothing to open.
  const hasOwnPage = focus.kind !== 'notice' || resolveInboxNoticeOwnPageRoute(notice, focus.serverId) !== null;
  const openLabel = describeOpenPage(focus);
  const renderControls = React.useCallback(
    () => (
      <>
        {hasOwnPage ? <IconButton
          testID="inbox.detail.open"
          variant="plain"
          iconName="arrow-square-out"
          accessibilityLabel={openLabel}
          tooltip={openLabel}
          onPress={() => router.push(pageRoute as never)}
        /> : null}
        <IconButton
          testID="inbox.detail.close"
          variant="plain"
          iconName="x"
          accessibilityLabel={t('common.close')}
          tooltip={t('common.close')}
          onPress={onClose}
        />
      </>
    ),
    [hasOwnPage, onClose, openLabel, pageRoute, router],
  );
  useStackHeaderActionsPublisher(scopeKey, renderControls);
  const controlsInHeader = useStackHeaderActionsClaimed(scopeKey);
  const focusKey = `${focus.kind}:${focus.serverId}:${focus.id}:${focus.kind === 'workflow_run' ? focus.invocationId ?? '' : focus.kind === 'discussion' ? focus.messageId : ''}`;

  return (
    <View testID="inbox.detail" style={styles.root}>
      {controlsInHeader ? null : (
        <View style={styles.bar}>{renderControls()}</View>
      )}
      {resolved ? <SurfaceStateCard testID="inbox.detail.resolved" kind="success" size="line"
        title={t('inbox.resolvedReceipt')} action={next ? { testID: 'inbox.detail.next', label: t('inbox.nextItem'),
          onPress: () => router.replace(createInboxItemRoute(next.focus, view) as never) } : undefined} /> : null}
      <HeaderActionsScope scopeKey={scopeKey}>
        <InboxItemDetailBody
          key={focusKey}
          focus={focus}
          pageRoute={pageRoute}
          onClose={onClose}
        />
      </HeaderActionsScope>
    </View>
  );
});

type DetailBodyProps = Readonly<{
    focus: InboxItemFocus;
    pageRoute: string;
    onClose: () => void;
}>;

function ApprovalDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'approval' ? (
        <ApprovalDetailScreen
          artifactId={props.focus.id}
          serverId={props.focus.serverId || undefined}
          onBack={props.onClose}
        />
      ) : null;
}
function SessionDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'session' ? (
        <SessionPeekDetailsView
          sessionId={props.focus.id}
          serverId={props.focus.serverId}
          active
          // The pane's own "open" already leaves for this session's page: one opener, not two.
          openControl={false}
        />
      ) : null;
}
function WorkflowDetailAdapter(props: DetailBodyProps) {
  return props.focus.kind === 'workflow_run' ? (
        <InboxRunDetail
          runId={props.focus.id}
          serverId={props.focus.serverId}
          invocationId={props.focus.invocationId}
          pageRoute={props.pageRoute}
          onClose={props.onClose}
        />
      ) : null;
}

/**
 * A stored notice: the page it points at when it has one; otherwise the notice itself (lab P4: an
 * item reads as what it is), never the generic document page with its stored JSON.
 */
function NoticeDetailAdapter(props: DetailBodyProps) {
  const model = useOptionalInboxModel();
  const entry = model?.accountNotices.find(candidate => candidate.artifact.id === props.focus.id);
  const investigation = React.useMemo(() => entry && model && model.noticeInvestigation.isEligible(entry)
    ? bindNoticeInvestigation(model.noticeInvestigation, entry) : null, [model?.noticeInvestigation, entry]);
  const ownPage = resolveInboxNoticeOwnPageRoute(entry?.header
    ?? model?.openUsageNotices.find(candidate => candidate.artifact.id === props.focus.id)?.header, props.focus.serverId);
  // Its page is this Inbox item: while the notices load, wait; a notice that is gone says so.
  if (!entry || !model) return model?.isLoading ? <PaneLoadingFallback /> : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
  const routeKey = createInboxItemRoute(props.focus).params.item;
  const item = model.items.find(candidate => createInboxItemRoute(candidate.focus).params.item === routeKey);
  // A failing service or an open provider alert is evidence: Investigate hands it to configured Triage.
  const subject = readNoticeInvestigationSubject(entry.header, model.noticeInvestigation.isEligible(entry));
  const plugin = entry.header.source.kind === 'plugin'
    ? { id: entry.header.source.pluginId, name: item?.source.displayName ?? entry.header.source.pluginId } : undefined;
  const content = ownPage ? <PageDetailAdapter {...props} plugin={plugin} /> : <InboxNoticeDetail title={item?.title ?? entry.header.title} body={item?.excerpt ?? entry.header.body ?? entry.header.excerpt ?? null}
    source={item?.source.displayName ?? null} createdAt={item?.createdAt ?? entry.artifact.createdAt}
    serverId={props.focus.serverId} subject={subject} investigation={investigation}
    onDismiss={async () => { await model.dismissAccountNotice(entry); props.onClose(); }} />;
  return entry.header.source.kind === 'plugin'
    ? <InboxPluginAvailability detail serverId={props.focus.serverId} pluginId={entry.header.source.pluginId}
        displayName={item?.source.displayName}>{content}</InboxPluginAvailability>
    : content;
}

function bindNoticeInvestigation(
  investigation: NonNullable<ReturnType<typeof useOptionalInboxModel>>['noticeInvestigation'],
  entry: AccountNoticeArtifact,
): BoundHealthNoticeInvestigation {
  return {
    readChoices: (options) => investigation.readChoices(entry, options),
    resume: (options) => investigation.resume(entry, options),
    run: (selection, options) => investigation.run(entry, selection, options),
  };
}

/** A notice as its own page; exported for the dev specimen that draws it over fixture outcomes. */
export const InboxNoticeDetail = React.memo(function InboxNoticeDetail(props: Readonly<{
  title: string; body: string | null; source: string | null; createdAt: number; onDismiss: () => Promise<void>;
  /** The Home the notice belongs to: where an approval Investigate asks for is opened. */
  serverId: string;
  subject?: NoticeInvestigationSubject | null;
  investigation?: BoundHealthNoticeInvestigation | null;
}>) {
  const { theme } = useUnistyles();
  const age = useWorkRelativeTime(props.createdAt);
  const [pending, setPending] = React.useState(false);
  const { onDismiss, subject } = props;
  const service = subject?.kind === 'service' ? subject : null;
  const dismiss = React.useCallback(async () => {
    setPending(true);
    try { await onDismiss(); }
    catch { Modal.alert(t('common.error'), t('errors.unknownError')); setPending(false); }
  }, [onDismiss]);
  const machineNames = useMachineDisplayNamesById(service ? [service.machineId] : NO_MACHINES);
  const machine = service ? machineNames[service.machineId] ?? service.machineId : null;
  const canInvestigate = subject?.investigable === true && props.investigation != null;
  const investigation = useBoundFailureInvestigation(canInvestigate ? props.investigation ?? null : null,
    { agentActions: 'withDefault' });
  const investigateHint = machine ? t('inbox.work.healthNotice.investigateHint', { machine }) : t('inbox.work.healthNotice.alertInvestigateHint');
  // One line says why an open notice offers no Investigate: the service's own section, else a quiet line.
  const ineligible = subject?.open === true && !canInvestigate ? t('inbox.work.healthNotice.investigateUnavailable') : undefined;
  return (
    <ItemList testID="inbox.notice.detail">
      <PageHeader
        testID="inbox.notice.header"
        alwaysShowTitle
        title={props.title}
        description={props.body ?? undefined}
        descriptionLines={0}
        meta={[...(props.source ? [{ key: 'source', text: props.source }] : []), { key: 'age', text: age }]}
        actions={(
          <>
            {canInvestigate ? (
              <InvestigationAgentActionButtons actions={investigation.actions ?? [{
                label: t('inbox.work.healthNotice.investigate'), launchMode: 'review', startable: true,
              }]} pending={investigation.pending} compact={false}
                onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }} />
            ) : null}
            <RoundButton testID="inbox.notice.dismiss" display="secondary" disabled={pending}
              title={t('inbox.actionOperations.dismiss')} onPress={dismiss} />
          </>
        )}
        actionsPlacement="page"
      />
      {investigation.showOutcome && investigation.outcome ? <InvestigationOutcomeBanner outcome={investigation.outcome} serverId={props.serverId} onChoosePlacement={investigation.investigateWithPlacement} pending={investigation.pending} /> : null}
      {ineligible && !service ? (
        <ItemGroup testID="inbox.notice.investigate.ineligible" surface="none" description={ineligible}>{null}</ItemGroup>
      ) : null}
      {service && machine ? (
        <ItemGroup testID="inbox.notice.health" title={t('inbox.work.healthNotice.where')}
          description={canInvestigate ? investigateHint : ineligible}>
          <Item testID="inbox.notice.health.service" icon={<Icon name="stack" size={18} color={theme.colors.text.secondary} />}
            title={t('inbox.work.healthNotice.service')} detail={service.service} mode="info" />
          <Item testID={`inbox.notice.health.machine.${service.machineId}`} icon={<Icon name="hard-drives" size={18} color={theme.colors.text.secondary} />}
            title={t('inbox.work.healthNotice.machine')} detail={machine} mode="info" />
        </ItemGroup>
      ) : null}
    </ItemList>
  );
});

const NO_MACHINES: readonly string[] = [];

const renderNoSession = () => null;
function PageDetailAdapter(props: DetailBodyProps & Readonly<{ plugin?: Readonly<{ id: string; name: string }> }>) {
  const catalog = useCompactAppDestinations();
  const router = useRouter();
  const target = React.useMemo(() => resolveDestinationRefFromHref(catalog, props.pageRoute), [catalog, props.pageRoute]);
  const navigation = React.useMemo<DestinationNavigation>(() => ({ push: router.push, replace: router.replace, back: props.onClose }),
    [router.push, router.replace, props.onClose]);
  if (!target) {
    const plugin = props.plugin;
    return plugin ? <PluginSurfaceFallback testID="plugin-app-page-unavailable"
      subjectName={plugin.name} reasonCode="plugin_app_page_unavailable"
      action={{ label: t('settingsPlugins.managePlugin'), onPress: () => {
        router.push(buildPluginDetailRoute('settings', plugin.id));
      } }} /> : <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
  }
  return <DestinationInstanceHost tabId={`inbox-detail:${props.focus.kind}:${props.focus.id}`} ref={target}
    pathname={props.pageRoute} focused visible navigation={navigation}>
    <WorkspaceDestinationBody target={target} pathname={props.pageRoute} renderSession={renderNoSession} renderSessionDetails={renderNoSession} />
  </DestinationInstanceHost>;
}

// Rendering mechanisms only; every source-to-adapter/page decision belongs to the registry above.
const DETAIL_ADAPTERS = { session: SessionDetailAdapter, approval: ApprovalDetailAdapter, workflow_run: WorkflowDetailAdapter, notice: NoticeDetailAdapter, page: PageDetailAdapter };
const InboxItemDetailBody = React.memo(function InboxItemDetailBody(props: DetailBodyProps) {
  const Adapter = DETAIL_ADAPTERS[INBOX_ITEM_DETAIL_REGISTRY[props.focus.kind].detail];
  return <Adapter {...props} />;
});

/**
 * A run is shown by its own page body, hosted here as a destination: the run page reads its run from
 * its destination params, and anything it opens leaves the Inbox for that page, while its Back
 * closes this pane.
 */
const InboxRunDetail = React.memo(function InboxRunDetail(
  props: Readonly<{
    runId: string;
    serverId: string;
    invocationId?: string;
    pageRoute: string;
    onClose: () => void;
  }>,
) {
  const router = useRouter();
  const navigation = React.useMemo<DestinationNavigation>(
    () => ({
      push: router.push,
      replace: router.replace,
      back: props.onClose,
    }),
    [props.onClose, router.push, router.replace],
  );
  return (
    <WorkflowRunPane
      tabId={`inbox-detail:run:${props.runId}`}
      runId={props.runId}
      serverId={props.serverId}
      invocationId={props.invocationId ?? null}
      pathname={props.pageRoute}
      visible
      navigation={navigation}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s8,
    paddingTop: theme.space.s8,
  },
}));
