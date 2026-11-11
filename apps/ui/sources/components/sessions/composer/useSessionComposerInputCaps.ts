import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import {
  computeExistingSessionComposerInputMaxHeight,
  computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import {
  useComposerAvailablePanelHeight,
  useComposerKeyboardLayoutContext,
} from '@/components/sessions/keyboardAvoidance';

function normalizeComposerKeyboardHeight(
  height: number | null | undefined,
): number {
  return typeof height === 'number' && Number.isFinite(height)
    ? Math.max(0, Math.round(height))
    : 0;
}

function useComposerKeyboardHeight(): number {
  const layout = useComposerKeyboardLayoutContext();
  const [keyboardHeight, setKeyboardHeight] = React.useState(() =>
    normalizeComposerKeyboardHeight(layout?.getKeyboardHeight?.()),
  );

  React.useEffect(() => {
    if (!layout) {
      setKeyboardHeight(0);
      return undefined;
    }

    setKeyboardHeight(
      normalizeComposerKeyboardHeight(layout.getKeyboardHeight?.()),
    );
    return layout.subscribeKeyboardHeight?.((nextHeight) => {
      const normalizedHeight = normalizeComposerKeyboardHeight(nextHeight);
      setKeyboardHeight((current) =>
        current === normalizedHeight ? current : normalizedHeight,
      );
    });
  }, [layout]);

  return keyboardHeight;
}

export type SessionComposerInputExpansionState = Readonly<{
  expanded: boolean;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
}>;

/**
 * The Session composer's panel and input caps. They read the keyboard scaffold the composer is rendered inside, so
 * they are derived in the composer's own subtree: the Session's composer controller runs above that scaffold and
 * saw no room at all, so every cap fell back to the whole window (native 2026-11-11). `reservedHeight` is the
 * measured stack of cards above the input in the same column.
 */
export function useSessionComposerInputCaps(
  input: Readonly<{
    reservedHeight: number;
    expansion: SessionComposerInputExpansionState;
  }>,
) {
  const { height: windowHeight } = useWindowDimensions();
  const availablePanelHeight =
    useComposerAvailablePanelHeight() ?? windowHeight;
  const keyboardHeight = useComposerKeyboardHeight();
  const { expanded, setExpanded } = input.expansion;
  const maxPanelHeight = React.useMemo(
    () =>
      computeExistingSessionComposerPanelMaxHeight({
        availablePanelHeight,
        reservedHeight: input.reservedHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, input.reservedHeight, windowHeight],
  );
  const collapsedMaxHeight = React.useMemo(
    () =>
      computeExistingSessionComposerInputMaxHeight({
        availablePanelHeight,
        reservedHeight: input.reservedHeight,
        expanded: false,
        keyboardHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, input.reservedHeight, keyboardHeight, windowHeight],
  );
  const expandedMaxHeight = React.useMemo(
    () =>
      computeExistingSessionComposerInputMaxHeight({
        availablePanelHeight,
        reservedHeight: input.reservedHeight,
        expanded: true,
        keyboardHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, input.reservedHeight, keyboardHeight, windowHeight],
  );
  const inputExpansion = React.useMemo(
    () => ({
      expanded,
      ...(typeof collapsedMaxHeight === 'number' ? { collapsedMaxHeight } : {}),
      onToggle: () => {
        setExpanded((current) => !current);
      },
    }),
    [collapsedMaxHeight, expanded, setExpanded],
  );
  return {
    maxPanelHeight,
    inputMaxHeight: expanded ? expandedMaxHeight : collapsedMaxHeight,
    inputExpansion,
  };
}
