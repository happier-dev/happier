import type { ReactElement, ReactNode } from 'react';

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

  return (
    <HappierStep
      marker={props.marker}
      {...(markerLabel === undefined ? {} : { markerLabel })}
      {...(stateGlyph === undefined ? {} : { stateGlyph })}
      title={title}
      trailing={props.trailing}
      theme={theme}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierStep>
  );
}
