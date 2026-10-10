import type { ReactElement } from 'react';

import { useHappierUiAccessibility } from '../environment/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierWidgetFrame, type HappierWidgetFrameProps } from '../presentation/layout/WidgetFrame.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** Public author adapter of the same structural frame rendered by Happier's widget hosts. */
export type WidgetFrameProps = Omit<HappierWidgetFrameProps,
  'cardStyle' | 'dividerColor' | 'renderText' | 'renderSourceGlyph' | 'disclosureMotion' | 'reducedMotion'>;

export function WidgetFrame(props: WidgetFrameProps): ReactElement {
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  const host = useOptionalPluginUiPresentationHost();
  return <HappierWidgetFrame {...props}
    cardStyle={{ backgroundColor: theme.colors.surface, borderColor: theme.colors.border, borderWidth: 1 }}
    dividerColor={theme.colors.border}
    disclosureMotion={host?.disclosureMotion}
    reducedMotion={reducedMotion || host?.disclosureMotion === undefined}
  />;
}
