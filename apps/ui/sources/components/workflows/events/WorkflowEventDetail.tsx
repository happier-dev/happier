import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType } from '@/utils/platform/responsive';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkflowSentenceBuilder } from '@/components/workflows/sentence/WorkflowSentenceBuilder';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { Icon } from '@/components/ui/icons/Icon';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ActivityEventTriggerPopover } from '@/components/workflows/triggers/TriggerFromActivityEvent';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';

import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import {
  prepareWorkflowEventEditorEntry,
  readWorkflowEventAddsLine,
  readWorkflowEventDraftIntent,
  readWorkflowEventLinkWhen,
  readWorkflowEventStartsLine,
  type WorkflowEventMatch,
} from './workflowEventFacts';
import {
  useWorkflowEventFact,
  useWorkflowEventPresentation,
  type WorkflowEventPresentation,
} from './useWorkflowEventPresentation';
import { useWorkflowEventsFeed } from './WorkflowEventsList';
import { WorkflowEventMark } from './WorkflowEventMark';
import { WorkflowEventActionBar, WorkflowEventMoreMenu, type WorkflowEventMenuItem } from './WorkflowEventActionBar';
import { WorkflowEventStartedRuns } from './WorkflowEventStartedRuns';

/**
 * What a fact carries (on demand): one label and value per line, the same body in the Events page and the Live
 * events companion. A fact no trigger can start from yet says so once, in place of an action that cannot work.
 */
export const WorkflowEventCarries = React.memo(function WorkflowEventCarries(
  props: Readonly<{
    presentation: WorkflowEventPresentation;
    automatable: boolean;
    testID: string;
    /** `none`: inside an expanded event's card, whose fill already groups the facts (no sheet within the card). */
    surface?: 'sheet' | 'none';
    /** The values a new workflow can match (`useWorkflowEventMatch`); the others stay facts. */
    match?: WorkflowEventMatchState | null;
  }>,
) {
  const { theme } = useUnistyles();
  const match = props.match ?? null;
  const pickable = match !== null && match.selectable;
  return (
    <ItemGroup
      testID={`${props.testID}:carries`}
      title={t('workflows.events.carries')}
      {...(props.surface ? { surface: props.surface } : {})}
      {...(!props.automatable ? { description: t('workflows.events.noTrigger') }
        // In an expanded card the check marks say it; a page's sheet says it above its rows.
        : pickable && props.surface !== 'none' ? { description: t('workflows.events.matchHint') } : {})}
    >
      {props.presentation.lines.map((line) => pickable && line.key === 'session' ? (
        <Item
          key={line.key}
          testID={`${props.testID}:carries:${line.key}`}
          title={line.label}
          detail={line.value}
          showChevron={false}
          accessibilityRole="checkbox"
          accessibilityChecked={match.selected}
          icon={<Icon name={match.selected ? 'check-circle' : 'circle'}
            color={match.selected ? theme.colors.text.primary : theme.colors.text.secondary} />}
          onPress={match.toggle}
        />
      ) : (
        <Item
          key={line.key}
          testID={`${props.testID}:carries:${line.key}`}
          title={line.label}
          detail={line.value}
          showChevron={false}
          // On a sheet with a picked value, every fact keeps the check column so the labels share one edge.
          {...(pickable ? { icon: <View /> } : {})}
        />
      ))}
      {match?.startsLine ? (
        <Item
          testID={`${props.testID}:starts`}
          title={match.startsLine}
          titleLines={0}
          icon={<Icon name="lightning" color={theme.colors.text.secondary} />}
          showChevron={false}
        />
      ) : null}
    </ItemGroup>
  );
});

/** What the person picked from an event's values, and the sentences that say what a new workflow would start on. */
export type WorkflowEventMatchState = Readonly<{
  /** Whether a carried value can narrow the start (a Session start's Session). */
  selectable: boolean;
  selected: boolean;
  toggle: () => void;
  match: WorkflowEventMatch | null;
  startsLine: string | null;
  addsLine: string | null;
}>;

/** One picked state per event: choosing another event starts unpicked again. */
export function useWorkflowEventMatch(
  presentation: WorkflowEventPresentation | null,
  scope: ServerAccountScope | null,
  /** A host whose body and actions render apart (the companion's phone bar) shares one pick between them. */
  shared?: Readonly<{ pickedKey: string | null; setPickedKey: React.Dispatch<React.SetStateAction<string | null>> }>,
): WorkflowEventMatchState {
  const [ownPickedKey, setOwnPickedKey] = React.useState<string | null>(null);
  const pickedKey = shared ? shared.pickedKey : ownPickedKey;
  const setPickedKey = shared ? shared.setPickedKey : setOwnPickedKey;
  const fact = presentation?.fact ?? null;
  const serverId = scope === null ? null : resolvePortableServerIdentityForRoutingId(scope.serverId);
  const selectable = fact !== null && serverId !== null && readWorkflowEventLinkWhen(fact) !== null;
  const selected = selectable && pickedKey === fact.key;
  const factKey = fact?.key ?? null;
  const toggle = React.useCallback(() => setPickedKey((current) => (current === factKey ? null : factKey)), [factKey, setPickedKey]);
  const match = React.useMemo(() => (selected && serverId !== null ? { session: { serverId } } : null), [selected, serverId]);
  const sessionName = presentation?.lines.find((line) => line.key === 'session')?.value ?? null;
  return {
    selectable, selected, toggle, match,
    startsLine: fact === null ? null : readWorkflowEventStartsLine(fact, match, sessionName),
    addsLine: fact === null ? null : readWorkflowEventAddsLine(fact, match, sessionName),
  };
}

/**
 * What a person can do with an observed event, shared by the Events page and the Live events companion, each also
 * published to Agents as a mounted command (`ui.current_context.command.invoke`):
 * - **Make a workflow from this**: a new workflow in the ordinary editor that already starts on the event; its Save
 *   is the editor's (`workflow.definition.create`).
 * - **Add to a workflow…**: the event's start on a saved workflow, through the trigger editor and `workflow.trigger.add`.
 * - **Automate this…**: the sentence builder with the event's trigger already chosen (S3).
 * Each reads the Account and Machines on the person's press, so an idle detail holds no subscription for them.
 */
export function useWorkflowEventIntents(
  presentation: WorkflowEventPresentation | null,
  active: boolean,
  /** `false` where the host has no Add to a workflow… control to anchor it (the companion adds to its own draft). */
  options?: Readonly<{ addTo?: boolean; match?: WorkflowEventMatch | null }>,
): Readonly<{
  anchorRef: React.RefObject<View | null>;
  /** The event's header: the builder opens below it, never over the event's subtitle. */
  headerRef: React.RefObject<View | null>;
  open: (() => void) | null;
  make: (() => void) | null;
  addTo: (() => void) | null;
  addToAnchorRef: React.RefObject<View | null>;
  /** The open sentence builder, if any. */
  builder: React.ReactNode;
  /** The open Add to a workflow… trigger editor, if any. */
  addToEditor: React.ReactNode;
}> {
  const router = useRouter();
  const anchorRef = React.useRef<View | null>(null);
  const headerRef = React.useRef<View | null>(null);
  const addToAnchorRef = React.useRef<View | null>(null);
  const [opening, setOpening] = React.useState<Readonly<{
    lifetime: ServerAccountScopeLifetime;
    key: number;
    intent: WorkflowSentenceEditorIntent;
  }> | null>(null);
  const [linking, setLinking] = React.useState<ActiveServerAccountScopeLifetime | null>(null);
  const keyRef = React.useRef(0);
  const fact = !active || presentation === null ? null : presentation.fact;
  const automatable = fact !== null && readWorkflowEventDraftIntent(fact) !== null;
  const match = options?.match ?? null;
  const linkWhen = fact === null || options?.addTo === false ? null : readWorkflowEventLinkWhen(fact, match);
  const title = presentation?.title ?? '';
  const readPlacement = React.useCallback(() => {
    // Read on the person's press: placing the draft on the event's Machine needs no live Machine/history subscription.
    const state = getStorage().getState();
    return {
      machines: resolveVisibleMachinesForActiveServerFromState(state),
      recentMachinePaths: state.authoringMemory.recentMachinePaths,
    };
  }, []);
  const open = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null || fact === null) return;
    const seed = readWorkflowEventDraftIntent(fact, readPlacement(), match);
    if (seed === null) return;
    keyRef.current += 1;
    const intent: WorkflowSentenceEditorIntent = { name: title, ...seed };
    setOpening({ lifetime, key: keyRef.current, intent });
  }, [fact, title, readPlacement, match]);
  const make = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null || fact === null) return false;
    const route = prepareWorkflowEventEditorEntry(fact, title, lifetime, readPlacement(), match);
    if (route === null) return false;
    router.push(route as never);
    return true;
  }, [fact, title, readPlacement, router, match]);
  const addTo = React.useCallback(() => {
    setLinking(captureActiveServerAccountScopeLifetime());
  }, []);
  useCurrentUiContextLocalCommands(automatable ? [
    { key: 'make-workflow', title: t('workflows.events.makeWorkflow'), invoke: make },
    ...(linkWhen === null ? [] : [{ key: 'add-to-workflow', title: t('workflows.events.addToAWorkflowTitle'), invoke: addTo }]),
    { key: 'automate', title: t('workflows.events.automate'), invoke: open },
  ] : [], { contextKey: fact?.key });
  const builder = opening === null ? null : (
    <WorkflowSentenceBuilder
      key={opening.key}
      anchorRef={anchorRef}
      clearanceRef={headerRef}
      accountLifetime={opening.lifetime}
      intent={opening.intent}
      // The event being automated names the builder ("Automate A Machine came online").
      resourceName={opening.intent.name}
      onRequestClose={() => setOpening(null)}
    />
  );
  const addToEditor = linking === null || linkWhen === null ? null : (
    <ActivityEventTriggerPopover
      testID="workflow-event-add-to"
      source={{ kind: 'when', when: linkWhen }}
      lifetime={linking}
      anchorRef={addToAnchorRef}
      newTitle={t('workflows.events.addToAWorkflowTitle')}
      onRequestClose={() => setLinking(null)}
    />
  );
  return {
    anchorRef, headerRef, addToAnchorRef, builder, addToEditor,
    open: automatable ? open : null,
    make: automatable ? () => { make(); } : null,
    addTo: automatable && linkWhen !== null ? addTo : null,
  };
}

/**
 * The Events tab's main pane (S1): the picked event's identity (its mark, what happened, what it is about and when),
 * its one action, and what it carries. With nothing picked, one line says what picking does.
 */
export const WorkflowEventDetailPage = React.memo(
  function WorkflowEventDetailPage(
    props: Readonly<{ eventKey: string | null }>,
  ) {
    const presented = useLayoutPresentationActive();
    const { feed, scope } = useWorkflowEventsFeed(presented);
    const fact = useWorkflowEventFact(feed.projection, props.eventKey);
    const presentation = useWorkflowEventPresentation(fact, scope, feed.retained?.runs, presented);
    const router = useRouter();
    const picked = useWorkflowEventMatch(presentation, scope);
    const automate = useWorkflowEventIntents(presentation, presented, { match: picked.match });
    // A phone keeps the event's actions in a foot bar (lab events:A:selected 390): Make, and the rest behind ⋯.
    const phone = useDeviceType() === 'phone';
    // On a phone ⋯ is where Add to a workflow… and Automate this… hang from.
    const moreAnchorRef = React.useCallback((node: View | null) => {
      automate.anchorRef.current = node;
      automate.addToAnchorRef.current = node;
    }, [automate.anchorRef, automate.addToAnchorRef]);
    // A picked row the feed hasn't settled is waiting or unreachable, not gone: say that, with the feed's Retry.
    if (presentation === null && props.eventKey !== null && (feed.status !== 'live' || feed.retained === null || feed.historyError !== null)) {
      return (
        <View style={styles.pick} testID="workflow-events:pick">
          <SurfaceStateCard
            testID="workflow-events:pick:feed"
            size="pane"
            {...(feed.status === 'failed' || feed.historyError !== null
              ? { kind: 'error' as const, title: t('workflows.events.failed'),
                  action: { label: t('workflows.retry'), onPress: () => { void feed.retry(); } } }
              : feed.status === 'offline'
                ? { kind: 'unavailable' as const, title: t('workflows.events.paused') }
                : { kind: 'loading' as const, title: t('workflows.events.connecting') })}
          />
        </View>
      );
    }
    if (presentation === null) {
      return (
        <View style={styles.pick} testID="workflow-events:pick">
          <EmptyState
            layout="centered"
            iconName="pulse"
            title={
              props.eventKey === null
                ? t('workflows.events.pickTitle')
                : t('workflows.events.gone')
            }
            subtitle={t('workflows.events.pickBody')}
          />
        </View>
      );
    }
    // A Machine event's row line is its time, which the header's own time already says: the header names it once.
    const meta = [
      ...(presentation.subtitle === null || presentation.fact.kind === 'machine'
        ? []
        : [{ key: 'subject', text: presentation.subtitle }]),
      { key: 'at', text: formatAsOfTime(presentation.fact.occurredAt) },
    ];
    const openTarget = presentation.open;
    const phoneMenu: WorkflowEventMenuItem[] = [
      ...(automate.addTo === null ? [] : [{ id: 'add-to', title: t('workflows.events.addToAWorkflow'), run: automate.addTo }]),
      ...(automate.open === null ? [] : [{ id: 'automate', title: t('workflows.events.automate'), run: automate.open }]),
      ...(openTarget === null ? [] : [{ id: 'open', title: openTarget.label, run: () => router.push(openTarget.href as never) }]),
    ];
    const barred = phone && automate.make !== null;
    return (
      <View style={styles.page}>
      <ItemList testID="workflow-events:detail">
        <View ref={automate.headerRef} collapsable={false}>
        <PageHeader
          testID="workflow-events:detail:header"
          title={presentation.title}
          // The event's sentence is its identity (lab events:A:selected 390): the mark keeps its title on phones.
          alwaysShowTitle
          leading={<PageHeaderMarkSlot><WorkflowEventMark presentation={presentation}
            size={HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx} /></PageHeaderMarkSlot>}
          meta={meta}
          actionsPlacement="page"
          {...(barred ? {} : { actions: (
            <View style={styles.actions}>
              {automate.make === null ? null : (
                <RoundButton
                  testID="workflow-events:detail:make"
                  size="small"
                  title={t('workflows.events.makeWorkflow')}
                  onPress={automate.make}
                />
              )}
              {automate.addTo === null ? null : (
                <View ref={automate.addToAnchorRef} collapsable={false}>
                  <RoundButton
                    testID="workflow-events:detail:add-to"
                    size="small"
                    display="secondary"
                    title={t('workflows.events.addToAWorkflow')}
                    onPress={automate.addTo}
                  />
                </View>
              )}
              {automate.open === null ? null : (
                <View ref={automate.anchorRef} collapsable={false}>
                  <SectionActionButton
                    testID="workflow-events:detail:automate"
                    title={t('workflows.events.automate')}
                    onPress={automate.open}
                  />
                </View>
              )}
              {openTarget === null ? null : (
                <SectionActionButton
                  testID="workflow-events:detail:open"
                  destination
                  title={openTarget.label}
                  onPress={() => router.push(openTarget.href as never)}
                />
              )}
            </View>
          ) })}
        />
        </View>
        <WorkflowEventCarries
          presentation={presentation}
          automatable={automate.open !== null}
          match={picked}
          testID="workflow-events:detail"
        />
        <WorkflowEventStartedRuns
          runs={presentation.runsStarted}
          scope={scope}
          testID="workflow-events:detail"
        />
      </ItemList>
      {barred ? (
        <WorkflowEventActionBar
          testID="workflow-events:detail:bar"
          more={<WorkflowEventMoreMenu items={phoneMenu} hint={presentation.title} anchorRef={moreAnchorRef}
            testID="workflow-events:detail:more" />}
          primary={<RoundButton testID="workflow-events:detail:make" title={t('workflows.events.makeWorkflow')}
            onPress={automate.make!} />}
        />
      ) : null}
      {automate.builder}
      {automate.addToEditor}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1, minHeight: 0 },
  pick: { flex: 1, minHeight: 0, justifyContent: 'center' },
  // Three actions and a link outgrow a phone's line: they wrap under each other instead of running off the edge.
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexWrap: 'wrap',
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '100%',
  },
}));
