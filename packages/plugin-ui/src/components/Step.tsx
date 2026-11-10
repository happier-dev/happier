import type { ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { HappierHeading } from '../presentation/content/Foundation.js';
import { happierFocusRingStyle } from '../presentation/interaction/focusVisible.js';
import { HappierPressable } from '../presentation/interaction/Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../presentation/interaction/pressFeedback.js';
import {
  HAPPIER_STEP_STATE_TONE,
  HappierStep,
  type HappierStepMarker,
  type HappierStepState,
} from '../presentation/content/Step.js';
import { Icon } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type StepMarker = HappierStepMarker;
export type StepState = HappierStepState;

export type StepProps = Readonly<{
  /** A count in the story, or the settled state of a check-like fact. */
  marker: StepMarker;
  title: string;
  /** A key from this plugin's declared translation bundle; `title` is its fallback. */
  titleKey?: string;
  /** Quiet context beside the title: a total, an author, a time. */
  trailing?: ReactNode;
  /**
   * The step's title opens where its whole story is told (What changed opens the changed files, Checks opens
   * the checks). The title becomes a link with a forward chevron; the step's body keeps its own controls.
   */
  onPress?: () => void;
  children?: ReactNode;
  testID?: string;
}>;

/**
 * One step of a numbered story rail (① the ask, ② what changed, a checks
 * state, ③ the agent's work). The marker sits on a visible fill in every
 * theme, and a state marker says its state in words.
 */
export function Step(props: StepProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const title = resolveAuthorText(translate, props.title, props.titleKey) ?? props.title;
  const marker = props.marker;
  const markerLabel = marker.kind === 'state'
    ? resolveAuthorText(translate, marker.label, marker.labelKey) ?? marker.label
    : undefined;
  const stateGlyph = marker.kind === 'state' && marker.state !== 'running' && marker.state !== 'open'
    ? <Icon name={marker.state === 'passed' ? 'check' : 'close'} size="small" tone={HAPPIER_STEP_STATE_TONE[marker.state]} />
    : undefined;
  const onPress = props.onPress;
  const titleContent = onPress === undefined ? undefined : (
    <HappierPressable
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={onPress}
      style={(state) => ({
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        maxWidth: '100%',
        gap: theme.spacing.xsmall,
        opacity: state.pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
        ...happierFocusRingStyle({ visible: state.focused, color: theme.colors.focus }),
      })}
    >
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <HappierHeading level={3} theme={theme}>{title}</HappierHeading>
      </View>
      <Icon name="forward" size="small" tone="secondary" />
    </HappierPressable>
  );

  return (
    <HappierStep
      marker={props.marker}
      {...(markerLabel === undefined ? {} : { markerLabel })}
      {...(stateGlyph === undefined ? {} : { stateGlyph })}
      title={title}
      {...(titleContent === undefined ? {} : { titleContent })}
      trailing={props.trailing}
      theme={theme}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierStep>
  );
}
