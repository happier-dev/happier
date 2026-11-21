import * as React from 'react';
import { PageRowDensityProvider } from '@/components/ui/lists/useResolvedItemDensity';
import { ContainedPageScopeProvider } from '@/components/ui/lists/listPresentation';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { Text } from '@/components/ui/text/Text';
import type { TriggerWhenValue } from '@/components/workflows/triggers/sessionTriggerForm';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import type { WorkflowTriggerDraftSeedIntent } from '../triggers/workflowTriggerStarts';
import { t } from '@/text';

import {
  readWorkflowEventWhen,
  readWorkflowEventDraftIntent,
  type WorkflowEventFilter,
} from './workflowEventFacts';
import {
  useWorkflowEventFact,
  useWorkflowEventPresentation,
} from './useWorkflowEventPresentation';
import { WorkflowEventActionBar, WorkflowEventMoreMenu, type WorkflowEventMenuItem } from './WorkflowEventActionBar';
import { WorkflowEventCarries, useWorkflowEventIntents, useWorkflowEventMatch, type WorkflowEventMatchState } from './WorkflowEventDetail';
import type { WorkflowEventPresentation } from './useWorkflowEventPresentation';
import { createWorkflowEventRoute } from '../workflowsRoutes';
import { WorkflowEventStartedRuns } from './WorkflowEventStartedRuns';
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
      onAddTrigger: ((when: TriggerWhenValue, seed?: WorkflowTriggerDraftSeedIntent) => string) | null;
      /** The trigger editor's answer to whether a row an add created is still there (Undo takes it away). */
      hasTriggerRow: ((clientId: string) => boolean) | null;
      /** Closes the companion; `null` where the host's own title and close already stand above. */
      onClose: (() => void) | null;
      /** `sheet`: the phone sheet, which carries the open row's actions in a bar at its foot (S2). */
      presentation?: 'pane' | 'sheet';
      testID: string;
    }>,
  ) {
    const { feed, scope } = useWorkflowEventsFeed(props.active);
    const [filter, setFilter] = React.useState<WorkflowEventFilter>('all');
    const [expanded, setExpanded] = React.useState<string | null>(null);
    // Which row each event's Add created; whether it still counts as added is the trigger editor's answer.
    const [addedRows, setAddedRows] = React.useState<ReadonlyMap<string, string>>(
      () => new Map(),
    );
    const { hasTriggerRow } = props;
    const isAdded = React.useCallback((key: string) => {
      const clientId = addedRows.get(key);
      return clientId !== undefined && hasTriggerRow !== null && hasTriggerRow(clientId);
    }, [addedRows, hasTriggerRow]);
    const toggle = useEventCallback((key: string) =>
      setExpanded((current) => (current === key ? null : key)),
    );
    // Which event's Session a new start matches; the open row's body and the phone bar read the same pick.
    const [pickedKey, setPickedKey] = React.useState<string | null>(null);
    const picked = React.useMemo(() => ({ pickedKey, setPickedKey }), [pickedKey]);
    // The phone sheet carries the open row's actions in a bar over the list (S2), not inside the row.
    const barred = props.presentation === 'sheet';
    const { onAddTrigger } = props;
    const add = useEventCallback((key: string, when: TriggerWhenValue, seed?: WorkflowTriggerDraftSeedIntent) => {
      const clientId = onAddTrigger?.(when, seed);
      if (clientId !== undefined) setAddedRows((current) => new Map(current).set(key, clientId));
    });
    const renderExpanded = React.useCallback(
      (key: string) => (
        <LiveEventBody
          projection={feed.projection}
          active={props.active}
          eventKey={key}
          scope={scope}
          retainedRuns={feed.retained?.runs}
          added={isAdded(key)}
          onAdd={onAddTrigger === null ? null : add}
          picked={picked}
          barred={barred}
          testID={props.testID}
        />
      ),
      [feed.projection, feed.retained?.runs, scope, isAdded, onAddTrigger, add, picked, barred, props.testID, props.active],
    );
    return (
      // The pane owns its insets in both hosts: inside the phone sheet its list adds no card gutter of its own, so the
      // rows sit as they do in the side pane rather than one gutter further in.
      <ContainedPageScopeProvider contained={false}>
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
            historyError={feed.historyError}
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
        {barred && expanded !== null ? (
          <LiveEventBar
            projection={feed.projection}
            active={props.active}
            eventKey={expanded}
            scope={scope}
            retainedRuns={feed.retained?.runs}
            added={isAdded(expanded)}
            onAdd={onAddTrigger === null ? null : add}
            picked={picked}
            testID={props.testID}
          />
        ) : null}
      </View>
      </ContainedPageScopeProvider>
    );
  },
);

type LiveEventProps = Readonly<{
  projection: WorkflowActivityProjection;
  active: boolean;
  eventKey: string;
  scope: ServerAccountScope | null;
  retainedRuns: readonly WorkflowRunSummaryV1[] | undefined;
  added: boolean;
  onAdd: ((key: string, when: TriggerWhenValue, seed?: WorkflowTriggerDraftSeedIntent) => void) | null;
  picked: Readonly<{ pickedKey: string | null; setPickedKey: React.Dispatch<React.SetStateAction<string | null>> }>;
  testID: string;
}>;

/** The expanded row's body: what the event carries (the Session it can match), then its actions unless a bar has them. */
const LiveEventBody = React.memo(function LiveEventBody(props: LiveEventProps & Readonly<{ barred: boolean }>) {
  const fact = useWorkflowEventFact(props.projection, props.eventKey);
  const presentation = useWorkflowEventPresentation(fact, props.scope, props.retainedRuns, props.active);
  const match = useWorkflowEventMatch(presentation, props.scope, props.picked);
  if (presentation === null) return null;
  const automatable = props.active && readWorkflowEventDraftIntent(presentation.fact) !== null;
  return (
    <View testID={`${props.testID}:expanded`} style={styles.body}>
      {/* A side pane's facts take the inspector's row size, as Session Info's do: the event's own rows stay larger. */}
      <PageRowDensityProvider value="inspector">
        <WorkflowEventCarries
          presentation={presentation}
          automatable={automatable}
          surface="none"
          // The companion says what Add brings above Add, so the facts carry no second start sentence.
          match={{ ...match, startsLine: null }}
          testID={`${props.testID}:expanded`}
        />
      </PageRowDensityProvider>
      <WorkflowEventStartedRuns
        runs={presentation.runsStarted}
        scope={props.scope}
        testID={`${props.testID}:expanded`}
      />
      {props.barred ? null : <LiveEventActions {...props} presentation={presentation} match={match} bar={false} />}
    </View>
  );
});

/** The phone sheet's bar over the list: the open row's Add and ⋯ (lab `companion:v:open` 390). */
const LiveEventBar = React.memo(function LiveEventBar(props: LiveEventProps) {
  const fact = useWorkflowEventFact(props.projection, props.eventKey);
  const presentation = useWorkflowEventPresentation(fact, props.scope, props.retainedRuns, props.active);
  const match = useWorkflowEventMatch(presentation, props.scope, props.picked);
  if (presentation === null) return null;
  return <LiveEventActions {...props} presentation={presentation} match={match} bar />;
});

/** What Add brings, Add to this workflow, and ⋯ (New workflow from this, Automate this…, Open in Events, Open …). */
function LiveEventActions(props: LiveEventProps & Readonly<{
  presentation: WorkflowEventPresentation;
  match: WorkflowEventMatchState;
  bar: boolean;
}>) {
  const router = useRouter();
  const { presentation, onAdd, eventKey } = props;
  const intents = useWorkflowEventIntents(presentation, props.active, { addTo: false, match: props.match.match });
  const seed = !props.active ? null : readWorkflowEventDraftIntent(presentation.fact, undefined, props.match.match);
  const when: TriggerWhenValue | null = seed?.nativeEvent
    ? { kind: 'pluginEvent', value: null }
    : readWorkflowEventWhen(presentation.fact, props.match.match);
  const open = presentation.open;
  const canAdd = when !== null && onAdd !== null;
  const addsLine = canAdd && !props.added ? props.match.addsLine : null;
  // One primary in the pane (Add to this workflow); the rest of what the event allows waits behind its ⋯ (S2).
  const menu: WorkflowEventMenuItem[] = [
    ...(intents.make === null ? [] : [{ id: 'make', title: t('workflows.events.newWorkflowFromThis'), run: intents.make }]),
    ...(intents.open === null ? [] : [{ id: 'automate', title: t('workflows.events.automate'), run: intents.open }]),
    { id: 'events', title: t('workflows.events.openInEvents'), run: () => router.push(createWorkflowEventRoute(eventKey) as never) },
    ...(open === null ? [] : [{ id: 'open', title: open.label, run: () => router.push(open.href as never) }]),
  ];
  const more = (
    <WorkflowEventMoreMenu items={menu} hint={presentation.title} anchorRef={intents.anchorRef} testID={`${props.testID}:more`} />
  );
  const primary = !canAdd ? null : props.added ? (
    <InlineStatus tone="success" label={t('workflows.events.added')} />
  ) : (
    <RoundButton
      testID={`${props.testID}:add`}
      size={props.bar ? 'normal' : 'small'}
      title={t('workflows.events.addToWorkflow')}
      onPress={() => onAdd(eventKey, when, seed?.nativeEvent ? { nativeEvent: seed.nativeEvent } : undefined)}
    />
  );
  return (
    <>
      {props.bar ? (
        <WorkflowEventActionBar testID={`${props.testID}:bar`} more={more} primary={primary} note={addsLine} />
      ) : (
        <>
          {addsLine === null ? null : (
            <Text testID={`${props.testID}:adds`} variant="meta" style={styles.adds}>{addsLine}</Text>
          )}
          <View style={styles.actions}>
            {primary}
            {more}
          </View>
        </>
      )}
      {intents.builder}
    </>
  );
}

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
  // What Add brings, on the facts' text edge just above it.
  adds: {
    color: theme.colors.text.secondary,
    paddingTop: theme.space.s8,
    paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    // The facts' last row and the action read as two steps, not one block.
    paddingTop: theme.space.s8,
    // On the list's text edge, inside the expanded event's card.
    paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
  },
}));
