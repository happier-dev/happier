import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import {
  computeExistingSessionComposerInputMaxHeight,
  computeExistingSessionComposerPanelMaxHeight,
} from '@/components/sessions/agentInput/inputMaxHeight';
import { useComposerAvailablePanelHeight } from '@/components/sessions/keyboardAvoidance/useComposerAvailablePanelHeight';
import { useComposerKeyboardLayout as useComposerKeyboardLayoutContext } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';
import { MULTI_TEXT_INPUT_BASE_LINE_HEIGHT } from '@/components/ui/forms/multiTextInputTypography';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';

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

/** Text lines the input always keeps visible, whatever stacks above it. */
const SESSION_COMPOSER_INPUT_FLOOR_LINES = 2;

/**
 * How the composer column's room is shared (owner 2026-11-11): the input keeps a floor (its controls plus two text
 * lines); the cards stacked above it get what that leaves as a max height and scroll inside it; the panel gets the
 * rest. The column therefore never runs past its room, and no card is clipped mid-control.
 */
export function resolveSessionComposerColumn(input: Readonly<{
    roomHeight: number;
    cardsContentHeight: number;
    inputFloorHeight: number;
}>): Readonly<{ cardsMaxHeight: number; cardsHeight: number }> {
    const room = Math.max(0, Math.round(input.roomHeight));
    const floor = Math.min(room, Math.max(0, Math.round(input.inputFloorHeight)));
    const cardsMaxHeight = room - floor;
    return { cardsMaxHeight, cardsHeight: Math.min(Math.max(0, Math.round(input.cardsContentHeight)), cardsMaxHeight) };
}

/**
 * The Session composer column's caps. They read the keyboard scaffold the composer is rendered inside, so they are
 * derived in the composer's own subtree: the Session's composer controller runs above that scaffold and saw no room
 * at all, so every cap fell back to the whole window (native 2026-11-11). `cardsContentHeight` is the measured
 * content of the card stack above the input; `textlessHeight` is the composer's measured height without its text.
 */
export function useSessionComposerInputCaps(
  input: Readonly<{
    cardsContentHeight: number;
    textlessHeight: number;
    expansion: SessionComposerInputExpansionState;
  }>,
) {
  const { height: windowHeight } = useWindowDimensions();
  const availablePanelHeight =
    useComposerAvailablePanelHeight() ?? windowHeight;
  const keyboardHeight = useComposerKeyboardHeight();
  const rawUiFontScale = useLocalSetting('uiFontScale');
  const lineHeight = Number(scaleTextStyle({ lineHeight: MULTI_TEXT_INPUT_BASE_LINE_HEIGHT },
    typeof rawUiFontScale === 'number' && rawUiFontScale > 0 ? rawUiFontScale : 1).lineHeight ?? MULTI_TEXT_INPUT_BASE_LINE_HEIGHT);
  const { cardsMaxHeight, cardsHeight } = resolveSessionComposerColumn({
    roomHeight: availablePanelHeight,
    cardsContentHeight: input.cardsContentHeight,
    inputFloorHeight: input.textlessHeight + SESSION_COMPOSER_INPUT_FLOOR_LINES * lineHeight,
  });
  const { expanded, setExpanded } = input.expansion;
  const maxPanelHeight = React.useMemo(
    () =>
      computeExistingSessionComposerPanelMaxHeight({
        availablePanelHeight,
        reservedHeight: cardsHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, cardsHeight, windowHeight],
  );
  const collapsedMaxHeight = React.useMemo(
    () =>
      computeExistingSessionComposerInputMaxHeight({
        availablePanelHeight,
        reservedHeight: cardsHeight,
        expanded: false,
        keyboardHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, cardsHeight, keyboardHeight, windowHeight],
  );
  const expandedMaxHeight = React.useMemo(
    () =>
      computeExistingSessionComposerInputMaxHeight({
        availablePanelHeight,
        reservedHeight: cardsHeight,
        expanded: true,
        keyboardHeight,
        viewportHeight: windowHeight,
      }),
    [availablePanelHeight, cardsHeight, keyboardHeight, windowHeight],
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
    cardsMaxHeight,
  };
}
