import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkflowSentenceBuilder } from '@/components/workflows/sentence/WorkflowSentenceBuilder';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { t } from '@/text';

import type { WorkflowSentenceEditorIntent } from '../authoring/workflowSentenceAuthoring';
import { useWorkflowEventDraftSeed } from './useWorkflowEventDraftSeed';
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
  }>,
) {
  return (
    <ItemGroup
      testID={`${props.testID}:carries`}
      title={t('workflows.events.carries')}
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
  open: (() => void) | null;
  builder: React.ReactNode;
}> {
  const anchorRef = React.useRef<View | null>(null);
  const [opening, setOpening] = React.useState<Readonly<{
    lifetime: ServerAccountScopeLifetime;
    key: number;
    intent: WorkflowSentenceEditorIntent;
  }> | null>(null);
  const keyRef = React.useRef(0);
  const seed = useWorkflowEventDraftSeed(presentation?.fact ?? null, active);
  const title = presentation?.title ?? '';
  const open = React.useCallback(() => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (lifetime === null || seed === null) return;
    keyRef.current += 1;
    const intent: WorkflowSentenceEditorIntent = seed.setupRequired
      ? { name: title, eventSeed: seed.eventSeed, payloadSchema: seed.payloadSchema }
      : { name: title, trigger: seed.trigger };
    setOpening({ lifetime, key: keyRef.current, intent });
  }, [seed, title]);
  const builder =
    opening === null ? null : (
      <WorkflowSentenceBuilder
        key={opening.key}
        anchorRef={anchorRef}
        accountLifetime={opening.lifetime}
        intent={opening.intent}
        onRequestClose={() => setOpening(null)}
      />
    );
  return { anchorRef, open: seed === null ? null : open, builder };
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
    const presentation = useWorkflowEventPresentation(fact, scope, feed.retained?.runs);
    const router = useRouter();
    const automate = useWorkflowEventAutomate(presentation, presented);
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
        <PageHeader
          testID="workflow-events:detail:header"
          title={presentation.title}
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
