import type { ReactElement, ReactNode } from 'react';

import { useHappierUiInsets } from '../environment/context.js';
import type {
  HappierAlignment,
  HappierJustification,
  HappierKeyboardShouldPersistTaps,
  HappierLayoutChangeEvent,
  HappierScrollEvent,
  HappierStyleProp,
} from '../presentation/portableTypes.js';
import {
  HappierScreen,
  HappierScrollArea,
  HappierStack,
  resolveHappierLayoutGap,
  type HappierLayoutGap,
} from '../presentation/layout/Layout.js';
import { usePluginTheme } from './PluginUiProvider.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';

export type LayoutGap = HappierLayoutGap;

/**
 * The measurement one layout box reports after the platform has laid it out.
 *
 * This is the whole responsive vocabulary an author needs: a box measures
 * itself and the surface decides what to do with the number. There is no
 * breakpoint table, dimensions hook or media-query layer above it, because a
 * plugin surface is sized by the host pane it is mounted in rather than by the
 * window.
 */
export type LayoutChangeEvent = HappierLayoutChangeEvent;

export type StackProps = Readonly<{
  children?: ReactNode;
  gap?: LayoutGap;
  wrap?: boolean;
  align?: HappierAlignment;
  justify?: HappierJustification;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type RowProps = StackProps;

export type ScreenProps = Readonly<{
  children?: ReactNode;
  safeArea?: boolean;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  /** Reports this box's resolved size and position after the platform lays it out. */
  onLayout?: (event: LayoutChangeEvent) => void;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type ScrollAreaProps = Readonly<{
  children?: ReactNode;
  horizontal?: boolean;
  keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
  onScroll?: (event: HappierScrollEvent) => void;
  scrollEventThrottle?: number;
  /** Reports the scroll viewport's resolved size and position, not its content's. */
  onLayout?: (event: LayoutChangeEvent) => void;
  accessibilityLabel?: string;
  safeArea?: boolean;
  testID?: string;
  style?: HappierStyleProp;
  contentContainerStyle?: HappierStyleProp;
}>;

function useGap(gap: LayoutGap = 'medium'): number {
  const { spacing } = usePluginTheme();
  return resolveHappierLayoutGap(gap, spacing);
}

export function Screen({ children, safeArea = false, focusTarget, ...props }: ScreenProps): ReactElement {
  const { safeArea: safeAreaInsets } = useHappierUiInsets();
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return (
    <HappierScreen {...props} controlRef={focusBinding} safeAreaInsets={safeArea ? safeAreaInsets : undefined}>
      {children}
    </HappierScreen>
  );
}

export function Stack({ gap = 'medium', focusTarget, ...props }: StackProps): ReactElement {
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return <HappierStack {...props} controlRef={focusBinding} direction="vertical" gap={useGap(gap)} />;
}

export function Row({ gap = 'medium', focusTarget, ...props }: RowProps): ReactElement {
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return <HappierStack {...props} controlRef={focusBinding} direction="horizontal" gap={useGap(gap)} />;
}

export function ScrollArea({ children, safeArea = false, ...props }: ScrollAreaProps): ReactElement {
  const { safeArea: safeAreaInsets } = useHappierUiInsets();
  return (
    <HappierScrollArea {...props} safeAreaInsets={safeArea ? safeAreaInsets : undefined}>
      {children}
    </HappierScrollArea>
  );
}
