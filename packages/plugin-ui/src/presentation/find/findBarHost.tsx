import * as React from 'react';
import { useCallback } from 'react';
import { TextInput, type TextStyle } from 'react-native';

import { PluginUiIconGlyph, type IconName } from '../../components/Icon.js';
import { HappierChevron } from '../collection/DisclosureChevron.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HappierText, useHappierTextPresentation } from '../text/Text.js';
import { scaleTextStyleMetrics } from '../text/textStyleScale.js';
import type { HappierFindBarGlyph, HappierFindBarHost, HappierFindBarInputProps } from './FindBar.js';

function FindInput({ ref, style, ...props }: HappierFindBarInputProps) {
  const presentation = useHappierTextPresentation({});
  const bindRef = useCallback((value: TextInput | null) => {
    if (typeof ref === 'function') ref(value);
    else if (ref) ref.current = value;
  }, [ref]);
  return <TextInput {...props} ref={bindRef} allowFontScaling={presentation.allowHostFontScaling}
    // The portable Find style crosses the native TextInput style boundary here.
    style={scaleTextStyleMetrics(style, presentation.metricScale) as TextStyle} />;
}

const ICONS = {
  search: 'search', close: 'close', history: 'waiting', offline: 'unavailable', info: 'info',
} as const satisfies Record<Exclude<HappierFindBarGlyph, 'previous' | 'next'>, IconName>;

/** Native controls for the existing bar; matching, placement and keyboard routing stay with its caller. */
export const HAPPIER_FIND_BAR_HOST: HappierFindBarHost = {
  Text: ({ mono, ...props }) => <HappierText {...props} variant={mono ? 'code' : undefined} />,
  TextInput: FindInput,
  renderGlyph: (glyph, color, size) => glyph === 'previous' || glyph === 'next'
    ? <HappierChevron direction={glyph === 'previous' ? 'up' : 'down'} color={color} size={size} />
    : <PluginUiIconGlyph name={ICONS[glyph]} color={color} size={size} />,
  renderSpinner: (color, size) => <HappierSpinner color={color} size={size} />,
};
