import type { ReactElement } from 'react';
import {
  OfferedChoices as PresentationOfferedChoices,
  OfferedChoiceFeedbackInput as PresentationFeedbackInput,
  type OfferedChoicesProps as PresentationOfferedChoicesProps,
  type OfferedChoiceFeedbackInputProps as PresentationFeedbackInputProps,
} from '../presentation/interaction/OfferedChoices.js';
import { PluginUiIconGlyph } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type { OfferedChoice } from '../presentation/interaction/OfferedChoices.js';
export type OfferedChoicesProps = Omit<PresentationOfferedChoicesProps, 'theme' | 'renderButton' | 'renderFeedbackInput' | 'unavailableIcon'>;
export type OfferedChoiceFeedbackInputProps = Omit<PresentationFeedbackInputProps, 'theme' | 'renderInput'>;

/** Author theme/icon adapter; scope and submission remain with the caller. */
export function OfferedChoices(props: OfferedChoicesProps): ReactElement {
  return <PresentationOfferedChoices {...props} theme={usePluginTheme()}
    unavailableIcon={<PluginUiIconGlyph name="info" size={14} tone="secondary" />} />;
}

export function OfferedChoiceFeedbackInput(props: OfferedChoiceFeedbackInputProps): ReactElement {
  return <PresentationFeedbackInput {...props} theme={usePluginTheme()} />;
}
