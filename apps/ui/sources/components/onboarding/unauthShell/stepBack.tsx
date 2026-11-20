import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { useUnauthShellLayout } from './useUnauthShellLayout';


/** Back's test id wherever a step draws it; the reversed step morph keys on it. */
export const UNAUTH_BACK_TEST_ID = 'unauth-shell-back-chevron';

/** The drawn size of Back and of the ways beside it (lab direction A: 44 px round wells). */
export const STEP_ROW_BUTTON_PX = 44;
/** Their glyph: the default icon step, so a well reads as a quiet mark rather than a filled tile (lab: 20 px). */
const STEP_ROW_GLYPH_PX = ICON_SIZE.md;
const STEP_ROW_WELL_STYLE = { width: STEP_ROW_BUTTON_PX, height: STEP_ROW_BUTTON_PX, borderRadius: STEP_ROW_BUTTON_PX / 2 } as const;

/**
 * One round well on a step's row: Back and every way beside it are the same object (direction A, owner 2026-11-19),
 * so their size, glyph and edge are decided here once.
 */
export function StepRowWayButton(
  props: Readonly<Omit<React.ComponentProps<typeof IconButton>, 'size' | 'iconSize' | 'variant'>>,
) {
  // The well stands on the welcome atmosphere as an Element: glass over the planet and field, its exact solid paint
  // under Reduce Transparency. Its fill and hover take that material's inner step through the shared resolver.
  return (
    <GlassSurface surfaceGroup="card" nested finishRole={null} style={STEP_ROW_WELL_STYLE}>
      <IconButton {...props} size={STEP_ROW_BUTTON_PX} iconSize={STEP_ROW_GLYPH_PX} variant="outlined" />
    </GlassSurface>
  );
}

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

/** The test id of a dead end's "Back to Happier" pill, which stands in for Back. */
export const UNAUTH_LEAVE_TEST_ID = 'unauth-shell-leave';

/**
 * A dead end draws its way out as the page's pill on every device (lab direction A), so it takes the shell's Back on a
 * computer and a phone alike: the shell then draws no Back of its own, while Escape and Android back still reach it.
 */
export function useStepLeave(): (() => void) | null {
  const slot = React.useContext(StepBackContext);
  useIsomorphicLayoutEffect(() => (slot ? slot.claim() : undefined), [slot]);
  return slot ? slot.onBack : null;
}

/** Back as a round well, the same object as the ways beside it; the reversed step morph keys on its test id. */
export function StepRowBackButton(props: Readonly<{ onPress: () => void; disabled?: boolean }>) {
  return (
    <StepRowWayButton
      testID={UNAUTH_BACK_TEST_ID}
      nativeID={Platform.OS === 'web' ? undefined : UNAUTH_BACK_TEST_ID}
      accessibilityLabel={t('common.back')}
      tooltip={t('common.back')}
      iconName="caret-left"
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
}

/** Back for a row that only needs the shell's Back (no step-local cleanup first); nothing on a phone. */
export function StepRowBack() {
    const back = useStepRowBack();
    return back ? <StepRowBackButton onPress={back} /> : null;
}

/** A step's one primary on a computer (lab direction A: at least 240 px, centred); on a phone it spans the column. */
const STEP_PRIMARY_MIN_WIDTH_PX = 240;

/**
 * A signed-out step's one primary (lab direction A `.r3-primary`): the large button, at least 240 px wide on a computer
 * and the column's width on a phone, its words followed by a forward arrow unless the step names another mark (`null`
 * for none, e.g. Try again). Every step's Continue is this one object.
 */
export function StepPrimaryButton(props: Readonly<{
  title: React.ReactNode;
  onPress?: () => unknown;
  loading?: boolean;
  disabled?: boolean;
  iconName?: IconName | null;
  testID?: string;
}>) {
  const { theme } = useUnistyles();
  const compact = useUnauthShellLayout() === 'compact';
  const iconName = props.iconName === undefined ? 'arrow-right' : props.iconName;
  return (
    <View style={compact ? stepPrimaryStyles.compact : stepPrimaryStyles.desktop}>
      <RoundButton
        testID={props.testID}
        size="large"
        title={props.title}
        // A press that settles later (a sign-in, a reset request) holds the button busy until it does.
        action={async () => { await props.onPress?.(); }}
        loading={props.loading}
        disabled={props.disabled}
        trailing={iconName ? <Icon name={iconName} size={ICON_SIZE.sm} color={theme.colors.button.primary.tint} /> : undefined}
      />
    </View>
  );
}

const stepPrimaryStyles = StyleSheet.create({
  desktop: { minWidth: STEP_PRIMARY_MIN_WIDTH_PX },
  compact: { alignSelf: 'stretch' },
});

/** A choice step's column (lab "Where should your Home live?"): two option cards side by side at a readable width. */
export const WIDE_STEP_COLUMN_PX = 680;

/** Claims the wide column for the step that renders it; the shell gives the column back when it unmounts. */
export const WideStepColumnContext = React.createContext<(() => () => void) | null>(null);

export function useWideStepColumn(): void {
  const claim = React.useContext(WideStepColumnContext);
  useIsomorphicLayoutEffect(() => (claim ? claim() : undefined), [claim]);
}

/** Renders its children in the wide step column (see {@link useWideStepColumn}). */
export function WideStepColumn(props: Readonly<{ children: React.ReactNode }>) {
  useWideStepColumn();
  return <>{props.children}</>;
}
