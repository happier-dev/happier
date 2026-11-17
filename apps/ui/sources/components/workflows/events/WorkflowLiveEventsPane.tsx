import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import type { TriggerWhenValue } from '@/components/workflows/triggers/sessionTriggerForm';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { t } from '@/text';

import {
  readWorkflowEventWhen,
  type WorkflowEventFilter,
} from './workflowEventFacts';
import {
  useWorkflowEventFact,
  useWorkflowEventPresentation,
} from './useWorkflowEventPresentation';
import { WorkflowEventCarries } from './WorkflowEventDetail';
import {
  WorkflowEventsFilters,
  WorkflowEventsListening,
  WorkflowEventsRows,
  useWorkflowEventsFeed,
} from './WorkflowEventsList';

/**
 * The editor's Live events companion (S2, D11): the same feed, rows and detail body as the Events tab, beside the
 * workflow being written. A row expands in place; its one primary adds that event's start to this workflow's
 * triggers, where Save writes it like any other.
 */
export const WorkflowLiveEventsPane = React.memo(
  function WorkflowLiveEventsPane(
    props: Readonly<{
      active: boolean;
      /** Adds the event's start to the mounted draft's triggers; absent when this person cannot manage them. */
      onAddTrigger: ((when: TriggerWhenValue) => void) | null;
      /** Closes the companion; `null` inside the phone sheet, whose own title and close already stand above. */
      onClose: (() => void) | null;
      testID: string;
    }>,
  ) {
    const { feed, scope } = useWorkflowEventsFeed(props.active);
    const [filter, setFilter] = React.useState<WorkflowEventFilter>('all');
    const [expanded, setExpanded] = React.useState<string | null>(null);
    const [added, setAdded] = React.useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const toggle = useEventCallback((key: string) =>
      setExpanded((current) => (current === key ? null : key)),
    );
    const { onAddTrigger } = props;
    const add = useEventCallback((key: string, when: TriggerWhenValue) => {
      onAddTrigger?.(when);
      setAdded((current) => new Set(current).add(key));
    });
    const renderExpanded = React.useCallback(
      (key: string) => (
        <LiveEventBody
          projection={feed.projection}
          eventKey={key}
          scope={scope}
          retainedRuns={feed.retained?.runs}
          added={added.has(key)}
          onAdd={onAddTrigger === null ? null : add}
          testID={props.testID}
        />
      ),
      [feed.projection, feed.retained?.runs, scope, added, onAddTrigger, add, props.testID],
    );
    return (
      <View testID={props.testID} style={styles.pane}>
        {props.onClose === null ? null : (
          <PaneHeader
            testID={`${props.testID}:header`}
            title={t('workflows.events.liveEvents')}
            onClose={props.onClose}
          />
        )}
        <View style={styles.head}>
          <WorkflowEventsListening
            testID={`${props.testID}:listening`}
            status={feed.status}
            listeningSince={feed.listeningSince}
            onRetry={feed.retry}
          />
          <WorkflowEventsFilters
            testID={`${props.testID}:filter`}
            projection={feed.projection}
            keys={feed.keys}
            value={filter}
            onChange={setFilter}
          />
        </View>
        <ItemList presentation="grouped" style={styles.list}>
          <WorkflowEventsRows
            testID={`${props.testID}:events`}
            feed={feed}
            scope={scope}
            filter={filter}
            selectedKey={expanded}
            onSelect={toggle}
            surface="page"
            active={props.active}
            renderExpanded={renderExpanded}
          />
        </ItemList>
      </View>
    );
  },
);

/** The expanded row's body: what the event carries, then its one action. */
const LiveEventBody = React.memo(function LiveEventBody(
  props: Readonly<{
    projection: WorkflowActivityProjection;
    eventKey: string;
    scope: ServerAccountScope | null;
    retainedRuns: readonly WorkflowRunSummaryV1[] | undefined;
    added: boolean;
    onAdd: ((key: string, when: TriggerWhenValue) => void) | null;
    testID: string;
  }>,
) {
  const router = useRouter();
  const fact = useWorkflowEventFact(props.projection, props.eventKey);
  const presentation = useWorkflowEventPresentation(fact, props.scope, props.retainedRuns);
  if (presentation === null) return null;
  const when = readWorkflowEventWhen(presentation.fact);
  const open = presentation.open;
  const { onAdd, eventKey } = props;
  return (
    <View testID={`${props.testID}:expanded`} style={styles.body}>
      <WorkflowEventCarries
        presentation={presentation}
        testID={`${props.testID}:expanded`}
      />
      <View style={styles.actions}>
        {when === null || onAdd === null ? null : props.added ? (
          <InlineStatus tone="success" label={t('workflows.events.added')} />
        ) : (
          <RoundButton
            testID={`${props.testID}:add`}
            size="small"
            title={t('workflows.events.addToWorkflow')}
            onPress={() => onAdd(eventKey, when)}
          />
        )}
        {open === null ? null : (
          <SectionActionButton
            testID={`${props.testID}:open`}
            destination
            title={open.label}
            onPress={() => router.push(open.href as never)}
          />
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  pane: { flex: 1, minHeight: 0 },
  // On the pane title's edge.
  head: {
    paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
    gap: theme.space.s4,
    paddingBottom: theme.space.s4,
  },
  list: { backgroundColor: 'transparent' },
  body: { paddingBottom: theme.space.s12 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
  },
}));
