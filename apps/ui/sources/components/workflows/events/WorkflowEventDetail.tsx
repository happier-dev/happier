import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
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
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';

import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { readWorkflowEventDraftIntent } from './workflowEventFacts';
import {
  useWorkflowEventFact,
  useWorkflowEventPresentation,
  type WorkflowEventPresentation,
} from './useWorkflowEventPresentation';
import { useWorkflowEventsFeed } from './WorkflowEventsList';
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
  }>,
) {
  return (
    <ItemGroup
      testID={`${props.testID}:carries`}
      title={t('workflows.events.carries')}
      {...(props.surface ? { surface: props.surface } : {})}
      {...(props.automatable ? {} : { description: t('workflows.events.noTrigger') })}
    >
      {props.presentation.lines.map((line) => (
        <Item
          key={line.key}
          testID={`${props.testID}:carries:${line.key}`}
          title={line.label}
          detail={line.value}
          showChevron={false}
        />
      ))}
    </ItemGroup>
  );
});

/** "Automate this…": the sentence builder with the fact's trigger already chosen (S3), anchored to the button. */
export function useWorkflowEventAutomate(
  presentation: WorkflowEventPresentation | null,
  active: boolean,
): Readonly<{
  anchorRef: React.RefObject<View | null>;
  /** The event's header: the builder opens below it, never over the event's subtitle. */
  headerRef: React.RefObject<View | null>;
  open: (() => void) | null;
  builder: React.ReactNode;
}> {
  const anchorRef = React.useRef<View | null>(null);
  const headerRef = React.useRef<View | null>(null);
  const [opening, setOpening] = React.useState<Readonly<{
    lifetime: ServerAccountScopeLifetime;
    key: number;
    intent: WorkflowSentenceEditorIntent;
  }> | null>(null);
  const keyRef = React.useRef(0);
  const fact = !active || presentation === null ? null : presentation.fact;
  const automatable = fact !== null && readWorkflowEventDraftIntent(fact) !== null;
  const title = presentation?.title ?? '';
  const open = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null || fact === null) return;
    // Read on the person's press: placing the draft on the event's Machine needs no live Machine/history subscription.
    const state = getStorage().getState();
    const seed = readWorkflowEventDraftIntent(fact, {
      machines: resolveVisibleMachinesForActiveServerFromState(state),
      recentMachinePaths: state.authoringMemory.recentMachinePaths,
    });
    if (seed === null) return;
    keyRef.current += 1;
    const intent: WorkflowSentenceEditorIntent = { name: title, ...seed };
    setOpening({ lifetime, key: keyRef.current, intent });
  }, [fact, title]);
  useCurrentUiContextLocalCommands(automatable ? [{
    key: 'automate', title: t('workflows.events.automate'), invoke: open,
  }] : [], { contextKey: fact?.key });
  const builder =
    opening === null ? null : (
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
  return { anchorRef, headerRef, open: automatable ? open : null, builder };
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
    const automate = useWorkflowEventAutomate(presentation, presented);
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
    const meta = [
      ...(presentation.subtitle === null
        ? []
        : [{ key: 'subject', text: presentation.subtitle }]),
      { key: 'at', text: formatAsOfTime(presentation.fact.occurredAt) },
    ];
    const openTarget = presentation.open;
    return (
      <ItemList testID="workflow-events:detail">
        <View ref={automate.headerRef} collapsable={false}>
        <PageHeader
          testID="workflow-events:detail:header"
          title={presentation.title}
          // The event's sentence is its identity (lab events:A:selected 390): the mark keeps its title on phones.
          alwaysShowTitle
          leading={<PageHeaderMarkIcon name={presentation.glyph} />}
          meta={meta}
          actionsPlacement="page"
          actions={
            <View style={styles.actions}>
              {automate.open === null ? null : (
                <View ref={automate.anchorRef} collapsable={false}>
                  <RoundButton
                    testID="workflow-events:detail:automate"
                    size="small"
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
          }
        />
        </View>
        <WorkflowEventCarries
          presentation={presentation}
          automatable={automate.open !== null}
          testID="workflow-events:detail"
        />
        <WorkflowEventStartedRuns
          runs={presentation.runsStarted}
          scope={scope}
          testID="workflow-events:detail"
        />
        {automate.builder}
      </ItemList>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  pick: { flex: 1, minHeight: 0, justifyContent: 'center' },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexWrap: 'wrap',
  },
}));
