import type { ReactElement } from 'react';

import { useHappierUiAccessibility } from '../environment/context.js';
import {
  FloatingFrame as SharedFloatingFrame,
  type FloatingFrameProps as PresentationFloatingFrameProps,
} from '../presentation/layout/FloatingFrame.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** Controlled author adapter over the same frame that the Session viewer renders. */
export type FloatingFrameProps = Omit<PresentationFloatingFrameProps, 'colors' | 'reducedMotion'>;

export function FloatingFrame(props: FloatingFrameProps): ReactElement {
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  return <SharedFloatingFrame {...props}
    colors={{ grip: theme.colors.secondaryText, focusRing: theme.colors.focus }}
    reducedMotion={reducedMotion}
  />;
}
