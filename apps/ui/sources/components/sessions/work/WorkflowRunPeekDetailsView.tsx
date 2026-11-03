import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DestinationNavigation } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
  HeaderActionsScope,
  useClaimedStackHeaderActions,
  useStackHeaderActionsClaimed,
  useStackHeaderActionsPublisher,
} from '@/components/navigation/stackHeaderActions';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { WorkflowRunPane } from '@/components/workflows/run/WorkflowRunPane';
import {
  createWorkflowInvocationRoute,
  createWorkflowRunRoute,
  readWorkflowRunRouteTarget,
} from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';

const PeekBackContext = React.createContext<(() => void) | null>(null);

/** Back from a step to its run, on the step header's title line (handed over as the pane's back control). */
function PeekStepBack(props: Readonly<{ style: StyleProp<ViewStyle> }>) {
  const back = React.useContext(PeekBackContext);
  if (back === null) return null;
  return (
    <View style={props.style}>
      <IconButton
        testID="workflow-run-peek-back"
        variant="plain"
        iconName="caret-left"
        accessibilityLabel={t('common.back')}
        tooltip={t('common.back')}
        onPress={back}
      />
    </View>
  );
}

/**
 * The peek of a workflow run the lead started (ORC §3.8): FIN's run page body beside the lead, so the
 * lead stays where it is. Opening a step stays in the peek — the step's own conversation (the one
 * `SessionInPane`) with Back to the run — while anything else the run opens leaves for its page. The
 * header carries "Open run" next to the pane's own controls, as the Session peek's does.
 */
export const WorkflowRunPeekDetailsView = React.memo(
  function WorkflowRunPeekDetailsView(
    props: Readonly<{
      runId: string;
      serverId: string | null;
      active: boolean;
      onClose: () => void;
    }>,
  ) {
    const { runId, serverId, onClose } = props;
    const router = useRouter();
    const [invocationId, setInvocationId] = React.useState<string | null>(null);
    const invocationIdRef = React.useRef(invocationId);
    invocationIdRef.current = invocationId;
    const pageRoute =
      invocationId === null
        ? createWorkflowRunRoute(runId, serverId)
        : createWorkflowInvocationRoute(runId, invocationId, serverId);

    const navigation = React.useMemo<DestinationNavigation>(() => {
      const go = (href: Parameters<DestinationNavigation['push']>[0]) => {
        const target = readWorkflowRunRouteTarget(href);
        if (target !== null && target.runId === runId) {
          setInvocationId(target.invocationId);
          return;
        }
        // Leaving the peek opens a page; it never replaces the lead underneath.
        router.push(href);
      };
      return {
        push: go as DestinationNavigation['push'],
        replace: go as DestinationNavigation['replace'],
        back: () => {
          if (invocationIdRef.current !== null) setInvocationId(null);
          else onClose();
        },
      };
    }, [onClose, router, runId]);

    const backToRun = React.useCallback(() => setInvocationId(null), []);

    // The pane lends its controls (focus, close) to this tab; they ride in the run's own header with
    // "Open run" before them, or on a slim bar while the run draws no header (loading, unavailable).
    const paneControls = useClaimedStackHeaderActions({ scopeOnly: true });
    const scopeKey = `workflow-run-peek:${React.useId()}`;
    const openRun = React.useCallback(
      () => router.push(pageRoute as never),
      [pageRoute, router],
    );
    const renderControls = React.useCallback(
      () => (
        <>
          <IconButton
            testID="workflow-run-peek-open"
            variant="plain"
            // Not ⤢: the pane's own chrome uses that to widen the pane. This leaves for the run's page.
            iconName="arrow-square-out"
            accessibilityLabel={t('inbox.work.groups.openRun')}
            tooltip={t('inbox.work.groups.openRun')}
            onPress={openRun}
          />
          {paneControls}
        </>
      ),
      [openRun, paneControls],
    );
    useStackHeaderActionsPublisher(
      scopeKey,
      props.active ? renderControls : null,
    );
    const controlsInHeader = useStackHeaderActionsClaimed(scopeKey);

    return (
      <View testID="workflow-run-peek" style={styles.root}>
        {!props.active || controlsInHeader ? null : (
          <View style={styles.bar}>{renderControls()}</View>
        )}
        <HeaderActionsScope scopeKey={scopeKey}>
          <PeekBackContext.Provider value={backToRun}>
            <NavigationBackChromeProvider
              control={invocationId === null ? null : PeekStepBack}
            >
              <WorkflowRunPane
                tabId={`workflow-run-peek:${runId}`}
                runId={runId}
                serverId={serverId}
                invocationId={invocationId}
                pathname={pageRoute}
                visible={props.active}
                acknowledgeFailure={false}
                navigation={navigation}
              />
            </NavigationBackChromeProvider>
          </PeekBackContext.Provider>
        </HeaderActionsScope>
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  bar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s8,
    paddingTop: theme.space.s8,
  },
}));
