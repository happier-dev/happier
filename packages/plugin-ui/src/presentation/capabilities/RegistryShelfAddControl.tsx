import * as React from 'react';
import { View } from 'react-native';
import { useHappierUiTheme } from '../../environment/context.js';
import { HAPPIER_ICON_BUTTON_SIZE } from '../interaction/iconButtonChrome.js';
import { HappierMotionFeedback } from '../interaction/MotionFeedback.js';
import { HappierPoliteAccessibilityStatus } from '../feedback/PoliteAccessibilityStatus.js';

export type RegistryShelfAddState = 'available' | 'adding' | 'added' | 'failed';
export type RegistryShelfAddControlProps = Readonly<{
  state: RegistryShelfAddState;
  title: string;
  addLabel: string;
  addedLabel: string;
  failedLabel: string;
  onAdd: () => void;
  testID: string;
}>;
type RetryProps = Readonly<{ testID: string; title: string; onPress: () => void }>;
export type RegistryShelfAddControlHost = Readonly<{
  renderAddedIcon: () => React.ReactNode;
  renderAddedLabel: (label: string) => React.ReactNode;
  renderRetry: (props: RetryProps) => React.ReactNode;
  renderAdd: (props: RetryProps & Readonly<{ accessibilityLabel: string; busy: boolean }>) => React.ReactNode;
}>;

/** The shared add lifecycle acknowledges only this mounted control's successful operation. */
export function HappierRegistryShelfAddControl(props: RegistryShelfAddControlProps & Readonly<{ host: RegistryShelfAddControlHost }>) {
  const theme = useHappierUiTheme();
  const [acknowledged, setAcknowledged] = React.useState({ state: props.state, count: 0 });
  let count = acknowledged.count;
  if (acknowledged.state !== props.state) {
    count += acknowledged.state === 'adding' && props.state === 'added' ? 1 : 0;
    setAcknowledged({ state: props.state, count });
  }
  const content = props.state === 'added' ? (
    <View testID={`${props.testID}.added`} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xsmall, minHeight: HAPPIER_ICON_BUTTON_SIZE }}>
      {props.host.renderAddedIcon()}
      {props.host.renderAddedLabel(props.addedLabel)}
    </View>
  ) : props.state === 'failed' ? props.host.renderRetry({
    testID: `${props.testID}.add`, title: props.failedLabel, onPress: props.onAdd,
  }) : props.host.renderAdd({
    testID: `${props.testID}.add`, title: props.addLabel,
    accessibilityLabel: `${props.addLabel}, ${props.title}`, busy: props.state === 'adding', onPress: props.onAdd,
  });
  return <>
    <HappierMotionFeedback trigger={count}>{content}</HappierMotionFeedback>
    <HappierPoliteAccessibilityStatus statusTestID={`${props.testID}.status`} transitionKey={String(count)}
      announcement={count === 0 ? '' : `${props.title}, ${props.addedLabel}`} />
  </>;
}
