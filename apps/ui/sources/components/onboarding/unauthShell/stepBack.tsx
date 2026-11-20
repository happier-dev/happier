import * as React from 'react';
import { Platform } from 'react-native';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { t } from '@/text';

import { UNAUTH_BACK_TEST_ID } from './BackChevron';

/** The drawn size of Back and of the ways beside it (lab direction A: 44 px round wells). */
export const STEP_ROW_BUTTON_PX = 44;

type StepBackSlot = Readonly<{
  onBack: () => void;
  /** `row`: a computer, where Back stands in the step's own row; `platform`: a phone's top-left back. */
  placement: 'row' | 'platform';
  claim: () => () => void;
    claimHandler: (handler: () => void) => () => void;
}>;

/** The shell's Back for the current step, provided by `WorkflowPanel`. */
export const StepBackContext = React.createContext<StepBackSlot | null>(null);

const useIsomorphicLayoutEffect =
  Platform.OS === 'web' && typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect;

export function useStepBackSlot(onBack: (() => void) | undefined, placement: StepBackSlot['placement']) {
  const parent = React.useRef(onBack);
  parent.current = onBack;
  const override = React.useRef<(() => void) | undefined>(undefined);
  const [rowClaims, setRowClaims] = React.useState(0);
  const enabled = onBack != null;
  const slot = React.useMemo<StepBackSlot | null>(() => enabled ? {
    onBack: () => (override.current ?? parent.current)?.(),
    placement,
    claim: () => {
      setRowClaims((count) => count + 1);
      return () => setRowClaims((count) => count - 1);
    },
    claimHandler: (handler) => {
      override.current = handler;
      return () => { if (override.current === handler) override.current = undefined; };
    },
  } : null, [enabled, placement]);
  return { slot, inRow: rowClaims > 0 };
}

export function useStepBackOverride(handler: (() => void) | undefined) {
  const slot = React.useContext(StepBackContext);
  useIsomorphicLayoutEffect(() => handler ? slot?.claimHandler(handler) : undefined, [handler, slot]);
  return slot;
}

/**
 * Direction A's Back on a computer (owner 2026-11-19): bottom-left of a centred Continue, or left of Approve's ways
 * row. A step row that draws it takes the shell's Back, and the shell then draws no corner Back of its own, so a
 * step never shows two. On a phone the platform back stays in the corner and this returns null.
 */
export function useStepRowBack(): (() => void) | null {
  const slot = React.useContext(StepBackContext);
  const inRow = slot !== null && slot.placement === 'row';
  useIsomorphicLayoutEffect(
    () => (inRow ? slot.claim() : undefined),
    [slot, inRow],
  );
  return inRow ? slot.onBack : null;
}

/** Back as a round well, the same object as the ways beside it; the reversed step morph keys on its test id. */
export function StepRowBackButton(props: Readonly<{ onPress: () => void }>) {
  return (
    <IconButton
      testID={UNAUTH_BACK_TEST_ID}
      nativeID={Platform.OS === 'web' ? undefined : UNAUTH_BACK_TEST_ID}
      accessibilityLabel={t('common.back')}
      tooltip={t('common.back')}
      iconName="caret-left"
      size={STEP_ROW_BUTTON_PX}
      variant="outlined"
      onPress={props.onPress}
    />
  );
}

/** Back for a row that only needs the shell's Back (no step-local cleanup first); nothing on a phone. */
export function StepRowBack() {
    const back = useStepRowBack();
    return back ? <StepRowBackButton onPress={back} /> : null;
}
