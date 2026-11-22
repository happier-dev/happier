import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierBodyEdgeContext } from '@happier-dev/plugin-ui/presentation';
import { isJsonObject } from '@happier-dev/protocol/json/strictJsonValue';

import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';
import type { ReviewWalkthroughPlan } from '@/sync/domains/reviews/reviewWalkthroughPlan';
import { t } from '@/text';

import { ReviewLabel } from '../ReviewLabel';

import { ReviewCostConsentRows, type ReviewStartCostConsent } from './ReviewCostConsentRows';
export type { ReviewStartCostConsent } from './ReviewCostConsentRows';

export type ReviewStartOptionsProps = Readonly<{
  then: 'report' | 'fix';
  onThenChange: (then: 'report' | 'fix') => void;
  walkthrough: boolean;
  onWalkthroughChange: (walkthrough: boolean) => void;
  /**
   * Who writes the walkthrough, from the host's walkthrough plan: asked in Advanced whenever Walk me through it is
   * on, whatever the roster (U8 R3 E2).
   */
  narrator?: Readonly<{ plan: ReviewWalkthroughPlan; onSelect: (engineId: string) => void }> | null;
  /** The host's keys and accounts control (Secret / Team credential selection). */
  credentials?: React.ReactNode;
  costs: readonly ReviewStartCostConsent[];
  disabled?: boolean;
  onSaveAsWorkflow?: () => void;
  /** The start's remaining launch settings (launch profiles, report back), asked once here in a sheet. */
  more?: React.ReactNode;
}>;

/**
 * Everything the start sheet asks once for the whole review, after its steps (Reviews lab rounds 6–12):
 * Then, Walk me through it and Advanced stay in the scroll body; Advanced names its contents while folded and
 * holds the narrator, keys and accounts and any engine estimate. A paid engine's consent follows as its own row.
 */
export function ReviewStartOptions(props: ReviewStartOptionsProps) {
  const [advanced, setAdvanced] = React.useState(false);
  const thenOptions = React.useMemo(
    () => [
      { id: 'report' as const, label: t('reviewWalkthrough.start.reportOnly') },
      { id: 'fix' as const, label: t('reviewWalkthrough.start.fixInSession') },
    ],
    [],
  );
  const costs = props.costs;
  const commands = useCurrentUiContextLocalCommands(props.disabled ? [] : [{
    key: 'review.start.then',
    title: t('reviewWalkthrough.start.then'),
    description: 'review.start.then — Choose what follows the Review with {value: "report" | "fix"}.',
    invoke: input => {
      if (!isJsonObject(input)) return false;
      const option = thenOptions.find(option => option.id === input.value);
      if (!option) return false;
      props.onThenChange(option.id);
    },
  }, {
    key: 'review.start.walkthrough',
    title: t('reviewWalkthrough.start.walkMeThrough'),
    description: 'review.start.walkthrough — Request a walkthrough with {value: boolean}.',
    invoke: input => {
      if (!isJsonObject(input) || typeof input.value !== 'boolean') return false;
      props.onWalkthroughChange(input.value);
    },
  }], { unbound: 'local' });
  return (
    <HappierBodyEdgeContext.Provider value>
    <View testID="review-start-options">
      <SegmentedChoiceItem
        testID="review-start-then"
        testIDPrefix="review-start-then"
        title={
          <ReviewLabel>
            {t('reviewWalkthrough.start.then')}
          </ReviewLabel>
        }
        accessibilityLabel={t('reviewWalkthrough.start.then')}
        options={thenOptions}
        value={props.then}
        onChange={value => { void commands.invoke('review.start.then', { value }); }}
        disabled={props.disabled}
        compact
      />
      <Item
        testID="review-start-walkthrough"
        title={
          <ReviewLabel>
            {t('reviewWalkthrough.start.walkMeThrough')}
          </ReviewLabel>
        }
        accessibilityLabel={t('reviewWalkthrough.start.walkMeThrough')}
        subtitle={t('reviewWalkthrough.start.walkMeThroughLine')}
        accessibilityRole="switch"
        accessibilityChecked={props.walkthrough}
        onPress={() => { void commands.invoke('review.start.walkthrough', { value: !props.walkthrough }); }}
        disabled={props.disabled}
        showChevron={false}
        rightElement={
          <Switch
            value={props.walkthrough}
            onValueChange={value => { void commands.invoke('review.start.walkthrough', { value }); }}
            disabled={props.disabled}
          />
        }
      />
      <ExpandableItem
        testID="review-start-advanced"
        expanded={advanced}
        onExpandedChange={setAdvanced}
        showDivider={false}
        bodyStyle={styles.advanced}
        header={({ headerProps, expanded }) => (
          <Item
            {...headerProps}
            testID="review-start-advanced:header"
            title={
              <ReviewLabel>
                {t('reviewWalkthrough.start.advanced')}
              </ReviewLabel>
            }
            accessibilityLabel={t('reviewWalkthrough.start.advanced')}
            detail={
              expanded
                ? undefined
                : t(
                    costs.length > 0
                      ? 'reviewWalkthrough.start.advancedContentsWithCost'
                      : 'reviewWalkthrough.start.advancedContents',
                  )
            }
          />
        )}
      >
        {props.walkthrough && props.narrator?.plan.narrator ? (
          <ReviewStartNarratorRow narrator={props.narrator.plan.narrator} selected={props.narrator.plan.selected}
            onSelect={props.narrator.onSelect} disabled={props.disabled} />
        ) : null}
        {props.credentials ? (
          <Item
            title={t('reviewWalkthrough.start.keysAndAccounts')}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={props.credentials}
          />
        ) : null}
        {props.more}
        {props.onSaveAsWorkflow ? <Item
          testID="review-start-save-as-workflow"
          title={t('workflows.run.saveAsWorkflow')}
          onPress={props.onSaveAsWorkflow}
          disabled={props.disabled}
        /> : null}
        {costs.map(cost => (
          <Item
            key={cost.id}
            title={cost.estimate ? t('reviewWalkthrough.start.costEstimate') : cost.title}
            mode="info"
            showChevron={false}
            detail={[cost.engine, cost.estimate ?? cost.description].filter(Boolean).join(' · ')}
          />
        ))}
      </ExpandableItem>
      <ReviewCostConsentRows costs={costs} disabled={props.disabled} />
    </View>
    </HappierBodyEdgeContext.Provider>
  );
}

/** Advanced › Narrator (lab `start-sheet`): a field select over the engines that can write a walkthrough. */
function ReviewStartNarratorRow(props: Readonly<{ narrator: NonNullable<ReviewWalkthroughPlan['narrator']>;
  selected: ReviewWalkthroughPlan['selected']; onSelect: (engineId: string) => void; disabled?: boolean }>) {
  const { narrator } = props;
  const items = React.useMemo(() => narrator.candidates.map(engine => ({ id: engine.engineId, title: engine.label,
    ...(engine.description ? { subtitle: engine.description } : {}) })), [narrator.candidates]);
  // Why a narrator is needed; a reviewer that writes its own needs no line.
  const why = narrator.candidates.length === 0 ? t('reviewWalkthrough.dialog.noNarrator')
    : narrator.reason === 'several' ? t('reviewWalkthrough.dialog.narratorSeveral', { count: props.selected.length })
    : narrator.reason === 'findings_only'
      ? t('reviewWalkthrough.dialog.narratorFindingsOnly', { engine: props.selected[0]?.label ?? '' }) : undefined;
  return (
    <Item
      testID="review-start-narrator-row"
      title={t('reviewWalkthrough.dialog.narrator')}
      subtitle={why}
      mode="info"
      showChevron={false}
      accessoryLayout="adaptive"
      rightElement={items.length > 0 ? (
        <ValueFieldSelect
          testID="review-start-narrator"
          label={t('reviewWalkthrough.dialog.narrator')}
          items={items}
          selectedId={narrator.engineId}
          placeholder={t('reviewWalkthrough.dialog.chooseNarrator')}
          onSelect={props.onSelect}
          disabled={props.disabled}
          compact
        />
      ) : undefined}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  advanced: { paddingBottom: theme.space.s8 },
}));
