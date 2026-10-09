import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';

import {
  describeManagedLifecycleState,
  managedLifecycleActionLabel,
  type ManagedLifecycleAction,
  type ManagedLifecycleState,
} from './managedLifecyclePresentation';

export type ManagedLifecycleHandlers = Partial<
  Record<ManagedLifecycleAction, () => void>
>;

/**
 * A created machine's row in a state that needs words (lab `m-life`): its mark and name, the cause in
 * the common vocabulary, and the next step. An action renders only when its owner supplied it, so a row
 * never offers a button that cannot work. The first action is the bordered one; the rest stay quiet.
 */
export const ManagedMachineStateRow = React.memo(
  function ManagedMachineStateRow(
    props: Readonly<{
      name: string;
      mark: React.ReactNode;
      state: ManagedLifecycleState;
      /** The provider's name, for "Open Hetzner". */
      provider?: string;
      handlers: ManagedLifecycleHandlers;
      /** A resource that ended reads dimmed: it is history, not something to act on. */
      ended?: boolean;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const presentation = describeManagedLifecycleState(props.state);
    const actions = presentation.actions.filter(
      (action) => props.handlers[action] !== undefined,
    );
    return (
      <Item
        testID={props.testID}
        title={props.name}
        subtitle={presentation.line}
        subtitleLines={0}
        subtitleLeading={
          presentation.tone === 'pending' ? (
            <ActivitySpinner
              size="small"
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : undefined
        }
        subtitleStyle={
          presentation.tone === 'warning'
            ? { color: theme.colors.state.warning.foreground }
            : presentation.tone === 'danger'
              ? { color: theme.colors.state.danger.foreground }
              : undefined
        }
        icon={
          <View style={props.ended ? styles.ended : null}>{props.mark}</View>
        }
        titleStyle={
          props.ended ? { color: theme.colors.text.secondary } : undefined
        }
        mode="info"
        showChevron={false}
        rightElement={
          actions.length > 0 ? (
            <View style={styles.actions}>
              {actions.map((action, index) => (
                <RoundButton
                  key={action}
                  testID={`${props.testID}:${action}`}
                  size="small"
                  display={
                    index === 0 && !props.ended ? 'secondary' : 'inverted'
                  }
                  title={managedLifecycleActionLabel(action, props.provider)}
                  onPress={props.handlers[action]!}
                />
              ))}
            </View>
          ) : undefined
        }
      />
    );
  },
);

const styles = StyleSheet.create(() => ({
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ended: {
    opacity: 0.55,
  },
}));
