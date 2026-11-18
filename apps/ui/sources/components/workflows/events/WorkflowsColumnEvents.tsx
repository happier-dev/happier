import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  usePathname,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import {
  createWorkflowEventRoute,
  WORKFLOWS_EVENTS_ROUTE,
} from '@/components/workflows/workflowsRoutes';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
  WorkflowEventsFilters,
  WorkflowEventsListening,
  WorkflowEventsRows,
  useWorkflowEventsFeed,
  type WorkflowEventsFeed,
} from './WorkflowEventsList';
import type { WorkflowEventFilter } from './workflowEventFacts';

export function isWorkflowEventsPath(pathname: string): boolean {
  return (
    pathname === WORKFLOWS_EVENTS_ROUTE ||
    pathname.startsWith(`${WORKFLOWS_EVENTS_ROUTE}/`)
  );
}

function readOpenWorkflowEventKey(pathname: string): string | null {
  if (!pathname.startsWith(`${WORKFLOWS_EVENTS_ROUTE}/`)) return null;
  const segment = pathname.slice(WORKFLOWS_EVENTS_ROUTE.length + 1);
  try {
    return segment.length > 0 ? decodeURIComponent(segment) : null;
  } catch {
    return null;
  }
}

/** The Workflows column's Events view state: one feed, borrowed only while the view is presented, and its filter. */
export function useWorkflowsColumnEvents(active: boolean) {
  const { feed, scope } = useWorkflowEventsFeed(active);
  const [filter, setFilter] = React.useState<WorkflowEventFilter>('all');
  return { feed, scope, filter, setFilter };
}
export type WorkflowsColumnEventsState = ReturnType<
  typeof useWorkflowsColumnEvents
>;

/** "Listening since 14:02": its own line under the view switch, above the kind pills. */
export function WorkflowsColumnEventsListening(
  props: Readonly<{ state: WorkflowsColumnEventsState }>,
) {
  const { feed } = props.state;
  return (
    <WorkflowEventsListening
      testID="workflows-column:events:listening"
      status={feed.status}
      listeningSince={feed.listeningSince}
      historyError={feed.historyError}
      onRetry={feed.retry}
    />
  );
}

/** The kind pills under the listening line. */
export function WorkflowsColumnEventsFilters(
  props: Readonly<{ state: WorkflowsColumnEventsState }>,
) {
  const { feed, filter, setFilter } = props.state;
  return (
    <View style={styles.filters}>
      <WorkflowEventsFilters
        testID="workflows-column:events:filter"
        projection={feed.projection}
        keys={feed.keys}
        value={filter}
        onChange={setFilter}
      />
    </View>
  );
}

/** The column's Events rows; a row opens the event in the main pane (or pushes it on a phone). */
export const WorkflowsColumnEventsRows = React.memo(
  function WorkflowsColumnEventsRows(
    props: Readonly<{
      feed: WorkflowEventsFeed;
      scope: ServerAccountScope | null;
      filter: WorkflowEventFilter;
      surface: 'plane' | 'page';
      active: boolean;
    }>,
  ) {
    const router = useRouter();
    const selectedKey = readOpenWorkflowEventKey(usePathname());
    const onSelect = useEventCallback((key: string) => {
      router.push(createWorkflowEventRoute(key) as never);
    });
    return (
      <WorkflowEventsRows
        testID="workflows-column:events"
        feed={props.feed}
        scope={props.scope}
        filter={props.filter}
        selectedKey={selectedKey}
        onSelect={onSelect}
        surface={props.surface}
        active={props.active}
      />
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  filters: { paddingBottom: theme.space.s4 },
}));
