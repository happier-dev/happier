import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HappierPressableProps } from './Pressable.js';

export type HappierDecisionAction = Readonly<{
  label: string;
  onPress: () => unknown;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  testID?: string;
  controlRef?: HappierPressableProps['controlRef'];
}>;

/** Runtime leaves only: the decision bar owns their order, availability and layout. */
export type HappierDecisionButtonProps = HappierDecisionAction & Readonly<{
  emphasis: 'primary' | 'secondary' | 'plain';
  size: 'normal' | 'small';
}>;

export type HappierDecisionBarProps = Readonly<{
  approve?: HappierDecisionAction;
  reject?: HappierDecisionAction;
  /** Supplied only when the caller's consent contract offers dismissal or cancellation. */
  dismiss?: HappierDecisionAction;
  disabled?: boolean;
  busy?: boolean;
  layout?: 'inline' | 'stacked';
  size?: 'normal' | 'small';
  Button: ComponentType<HappierDecisionButtonProps>;
  testID?: string;
}>;

export function HappierDecisionBar(props: HappierDecisionBarProps) {
  const { Button, size = 'normal', layout = 'inline' } = props;
  const actions = [
    { kind: 'approve', action: props.approve, emphasis: 'primary' },
    { kind: 'dismiss', action: props.dismiss, emphasis: 'plain' },
    { kind: 'reject', action: props.reject, emphasis: 'secondary' },
  ] as const;
  const busy = props.busy === true || actions.some(({ action }) => action?.busy === true);
  if (!actions.some(({ action }) => action !== undefined)) return null;

  return <View testID={props.testID} style={[
    layout === 'stacked' ? styles.stacked : styles.inline,
    size === 'small' ? styles.smallGap : styles.normalGap,
  ]}>
    {actions.map(({ kind, action, emphasis }) => {
      if (!action) return null;
      const disabled = props.disabled === true || busy || action.disabled === true;
      return <View key={kind} style={[styles.action, layout === 'stacked' ? styles.stackedAction : null]}>
        <Button {...action} emphasis={emphasis} size={size} disabled={disabled}
          onPress={() => disabled ? undefined : action.onPress()} />
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  stacked: { flexDirection: 'column', alignItems: 'stretch' },
  normalGap: { gap: 12 },
  smallGap: { gap: 8 },
  action: { minWidth: 0, maxWidth: '100%' },
  stackedAction: { width: '100%' },
});
