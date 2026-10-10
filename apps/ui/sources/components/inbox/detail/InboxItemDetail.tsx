import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  DestinationInstanceHost,
  type DestinationNavigation,
} from '@/components/appShell/workspace/DestinationInstanceHost';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ApprovalDetailScreen } from '@/components/approvals/ApprovalDetailScreen';
import {
  HeaderActionsScope,
  useStackHeaderActionsClaimed,
  useStackHeaderActionsPublisher,
} from '@/components/navigation/stackHeaderActions';
import { SessionPeekDetailsView } from '@/components/sessions/work/SessionPeekDetailsView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { WorkflowsGate } from '@/components/workflows/gating/WorkflowsGate';
import { WorkflowRunScreen } from '@/components/workflows/screens/WorkflowRunScreen';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { createWorkflowInvocationRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

import type { InboxItemFocus } from '../inboxItemFocus';

/** The selected item's own page, which "open" leaves for: the same place a phone pushes. */
export function resolveInboxItemPageRoute(focus: InboxItemFocus): string {
  switch (focus.kind) {
    case 'session':
      return createActivitySurfaceSessionRoute(focus.id, focus.serverId);
    case 'workflow_run':
      return focus.invocationId ? createWorkflowInvocationRoute(focus.id, focus.invocationId) : createWorkflowRunRoute(focus.id);
    case 'approval':
      return `/inbox/approvals/${encodeURIComponent(focus.id)}${focus.serverId ? `?serverId=${encodeURIComponent(focus.serverId)}` : ''}`;
  }
}

function describeOpenPage(focus: InboxItemFocus): string {
  switch (focus.kind) {
    case 'session':
      return t('inbox.work.groups.openSession');
    case 'workflow_run':
      return t('inbox.work.groups.openRun');
    case 'approval':
      return t('inbox.work.detail.openApproval');
  }
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
  }>,
) {
  const router = useRouter();
  const { focus, onClose } = props;
  const scopeKey = `inbox-detail:${React.useId()}`;
  const pageRoute = resolveInboxItemPageRoute(focus);
  const openLabel = describeOpenPage(focus);
  const renderControls = React.useCallback(
    () => (
      <>
        <IconButton
          testID="inbox.detail.open"
          variant="plain"
          iconName="arrow-square-out"
          accessibilityLabel={openLabel}
          tooltip={openLabel}
          onPress={() => router.push(pageRoute as never)}
        />
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
    [onClose, openLabel, pageRoute, router],
  );
  useStackHeaderActionsPublisher(scopeKey, renderControls);
  const controlsInHeader = useStackHeaderActionsClaimed(scopeKey);
  const focusKey = `${focus.kind}:${focus.serverId}:${focus.id}:${focus.kind === 'workflow_run' ? focus.invocationId ?? '' : ''}`;

  return (
    <View testID="inbox.detail" style={styles.root}>
      {controlsInHeader ? null : (
        <View style={styles.bar}>{renderControls()}</View>
      )}
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

const InboxItemDetailBody = React.memo(function InboxItemDetailBody(
  props: Readonly<{
    focus: InboxItemFocus;
    pageRoute: string;
    onClose: () => void;
  }>,
) {
  const { focus } = props;
  switch (focus.kind) {
    case 'approval':
      return (
        <ApprovalDetailScreen
          artifactId={focus.id}
          serverId={focus.serverId || undefined}
          onBack={props.onClose}
        />
      );
    case 'session':
      return (
        <SessionPeekDetailsView
          sessionId={focus.id}
          serverId={focus.serverId}
          active
          // The pane's own "open" already leaves for this session's page: one opener, not two.
          openControl={false}
        />
      );
    case 'workflow_run':
      return (
        <InboxRunDetail
          runId={focus.id}
          invocationId={focus.invocationId}
          pageRoute={props.pageRoute}
          onClose={props.onClose}
        />
      );
  }
});

/**
 * A run is shown by its own page body, hosted here as a destination: the run page reads its run from
 * its destination params, and anything it opens leaves the Inbox for that page, while its Back
 * closes this pane.
 */
const InboxRunDetail = React.memo(function InboxRunDetail(
  props: Readonly<{
    runId: string;
    invocationId?: string;
    pageRoute: string;
    onClose: () => void;
  }>,
) {
  const router = useRouter();
  const ref = React.useMemo(
    () => ({ kind: 'workflowRun', params: { runId: props.runId, ...(props.invocationId ? { invocationId: props.invocationId } : {}) } }),
    [props.runId, props.invocationId],
  );
  const navigation = React.useMemo<DestinationNavigation>(
    () => ({
      push: router.push,
      replace: router.replace,
      back: props.onClose,
    }),
    [props.onClose, router.push, router.replace],
  );
  return (
    <DestinationInstanceHost
      tabId={`inbox-detail:run:${props.runId}`}
      ref={ref}
      pathname={props.pageRoute}
      focused
      visible
      navigation={navigation}
    >
      <WorkflowsGate>
        <WorkflowRunScreen embedded />
      </WorkflowsGate>
    </DestinationInstanceHost>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: theme.colors.surface.base,
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
}));
