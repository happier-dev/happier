import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierUiTheme } from '../../environment/types.js';
import { HappierStep } from './Step.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';

export type HappierSetupStep = Readonly<{
  key: string;
  state?: 'done' | 'current' | 'upcoming';
  title: ReactNode;
  detail?: string;
  body?: ReactNode;
  testID?: string;
}>;

export type HappierSetupStepsProps = Readonly<{
  steps: readonly HappierSetupStep[];
  plain?: boolean;
  testID?: string;
  theme: HappierUiTheme;
  stateGlyph?: ReactNode;
  /** Adapters bind their text host, not another step layout or marker. */
  renderTitle?: (step: HappierSetupStep, plain: boolean) => ReactNode;
  renderDetail?: (detail: string) => ReactNode;
}>;

/** The ordered setup composition; numbering and settled/current markers belong to HappierStep. */
export function HappierSetupSteps(props: HappierSetupStepsProps) {
  const detailStyle = useHappierTypeRoleStyle('body', props.theme);
  return <View testID={props.testID} style={{ gap: props.plain ? 9 : 14 }} accessibilityRole="list">
    {props.steps.map((step, index) => <HappierStep key={step.key} testID={step.testID}
      marker={{ kind: 'number', value: index + 1 }} numberState={step.state ?? 'upcoming'}
      theme={props.theme} title={step.title} stateGlyph={props.stateGlyph}
      titleContent={props.renderTitle?.(step, props.plain === true) ?? (props.plain
        ? <HappierText style={[detailStyle, { color: props.theme.colors.text }]}>{step.title}</HappierText>
        : undefined)}>
      {step.detail ? props.renderDetail?.(step.detail) ?? <HappierText style={[detailStyle,
        { marginTop: 2, color: props.theme.colors.secondaryText }]}>{step.detail}</HappierText> : null}
      {step.body ? <View style={{ marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>{step.body}</View> : null}
    </HappierStep>)}
  </View>;
}
