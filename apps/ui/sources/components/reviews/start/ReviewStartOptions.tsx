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
import { t } from '@/text';

import { ReviewLabel } from '../ReviewLabel';

import { ReviewCostConsentRows, type ReviewStartCostConsent } from './ReviewCostConsentRows';
export type { ReviewStartCostConsent } from './ReviewCostConsentRows';

export type ReviewStartOptionsProps = Readonly<{
  then: 'report' | 'fix';
  onThenChange: (then: 'report' | 'fix') => void;
  walkthrough: boolean;
  onWalkthroughChange: (walkthrough: boolean) => void;
  /** The host's narrator field select ("Summary written by"). */
  narrator?: React.ReactNode;
  /** The host's keys and accounts control (Secret / Team credential selection). */
  credentials?: React.ReactNode;
  costs: readonly ReviewStartCostConsent[];
  disabled?: boolean;
  onSaveAsWorkflow?: () => void;
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
        {props.narrator ? (
          <Item
            title={t('reviewWalkthrough.dialog.narrator')}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={props.narrator}
          />
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

const styles = StyleSheet.create((theme) => ({
  advanced: { paddingBottom: theme.space.s8 },
}));
