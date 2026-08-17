import type { ReactElement, ReactNode } from 'react';

import { useHappierUiInsets } from '../environment/context.js';
import type {
  HappierAlignment,
  HappierJustification,
  HappierKeyboardShouldPersistTaps,
  HappierScrollEvent,
  HappierStyleProp,
} from '../presentation/portableTypes.js';
import {
  HappierScreen,
  HappierScrollArea,
  HappierStack,
  type HappierLayoutGap,
} from '../presentation/layout/Layout.js';
import { usePluginTheme } from './PluginUiProvider.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';

export type LayoutGap = HappierLayoutGap;

export type StackProps = Readonly<{
  children?: ReactNode;
  gap?: LayoutGap;
  wrap?: boolean;
  align?: HappierAlignment;
  justify?: HappierJustification;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type RowProps = StackProps;

export type ScreenProps = Readonly<{
  children?: ReactNode;
  safeArea?: boolean;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type ScrollAreaProps = Readonly<{
  children?: ReactNode;
  horizontal?: boolean;
  keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
  onScroll?: (event: HappierScrollEvent) => void;
  scrollEventThrottle?: number;
  accessibilityLabel?: string;
  safeArea?: boolean;
  testID?: string;
  style?: HappierStyleProp;
  contentContainerStyle?: HappierStyleProp;
}>;

function useGap(gap: LayoutGap = 'medium'): number {
  const { spacing } = usePluginTheme();
  return gap === 'none' ? 0 : spacing[gap];
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
