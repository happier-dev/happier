import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Animated, View, type LayoutChangeEvent } from 'react-native';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_MOTION_V1 } from './motion.js';
import { HappierPressable } from './Pressable.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from './pressFeedback.js';
import { HappierMaterialSurface, type HappierSurfaceProps } from '../layout/Surface.js';

/**
 * The ONE selection action bar (ui-primitives-audit §4): what every "N selected · actions · ✕" surface
 * draws — a plugin's `List.SelectionActionBar`, the transcript's and a conversation's message selection,
 * and the session list's bulk actions. It owns chrome only: the inverted pill, the count, one primary
 * action beside quiet ones, the ⋯ fold when the column is narrower than the bar, the ✕, and a short
 * enter/exit. It owns no selection, no execution, no confirmation and no progress — each consumer keeps
 * those and hands the bar a label and actions for the state it is in.
 */
export type HappierSelectionActionBarAction = Readonly<{
  id: string;
  /** Already-translated. */
  label: string;
  accessibilityLabel?: string;
  /** One `primary` per bar; `destructive` for the irreversible one. Everything else is quiet. */
  emphasis?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
  /** Work this action started is in flight; the press is refused until it settles. */
  busy?: boolean;
  testID?: string;
  /** Drawn before the label in the bar's foreground colour. */
  renderIcon?: (color: string) => ReactNode;
  onPress: () => unknown;
}>;

export type HappierSelectionActionBarOverflowItem = Readonly<{
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  testID?: string;
}>;

/**
 * What the embedding runtime supplies, so the bar keeps each runtime's own typography (core's font
 * scale, a plugin's environment text), glyph set and anchored menu without the bar owning a second one.
 */
export type HappierSelectionActionBarHost = Readonly<{
  Text: ComponentType<Readonly<{
    children: string;
    style: HappierPortableStyle;
    numberOfLines?: number;
    testID?: string;
    accessibilityLabel?: string;
    /** Tabular figures, so a changing count does not jitter. `fontVariant` is host-private, not portable style. */
    tabularNumbers?: boolean;
  }>>;
  renderGlyph: (glyph: 'dismiss' | 'more', color: string, size: number) => ReactNode;
  OverflowMenu: ComponentType<Readonly<{
    items: readonly HappierSelectionActionBarOverflowItem[];
    onSelect: (id: string) => void;
    accessibilityLabel: string;
    renderTrigger: (open: () => void) => ReactNode;
  }>>;
}>;

export type HappierSelectionActionBarProps = Readonly<{
  /** The bar keeps its last content through the exit, so it never flashes empty while it leaves. */
  visible: boolean;
  /** "2 selected", or the state the consumer is in ("Archiving 2 of 5", "Archive 3 sessions?"). */
  label: string;
  labelAccessibilityLabel?: string;
  labelTestID?: string;
  /** One quiet fact after the label ("Copied"). */
  status?: string | null;
  statusTestID?: string;
  actions: readonly HappierSelectionActionBarAction[];
  dismiss: Readonly<{
    /** Spoken name of the ✕; printed instead of the glyph with `presentation: 'label'`. */
    label: string;
    /** `label` when the one dismiss control does something other than clear (Stop, Done). */
    presentation?: 'glyph' | 'label';
    onPress: () => unknown;
    disabled?: boolean;
    testID?: string;
  }>;
  /** Accessible name of the ⋯ that holds folded actions. */
  moreLabel?: string;
  /** The inverted fill and its ink: the runtime's primary-button pair. */
  colors: Readonly<{ background: string; foreground: string; destructive?: string }>;
  host: HappierSelectionActionBarHost;
  /** Defaults to the environment's reduced-motion fact. */
  reducedMotion?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: HappierStyleProp;
  gradient?: HappierSurfaceProps['gradient'];
  renderMaterialSurface?: HappierSurfaceProps['renderMaterialSurface'];
}>;

export type HappierSelectionActionBarLayout = Readonly<{
  folded: boolean;
  inline: readonly HappierSelectionActionBarAction[];
  overflow: readonly HappierSelectionActionBarAction[];
}>;

/**
 * Whether the bar fits its column: folded only when the column is measurably narrower than the bar's
 * own natural width. The primary action (else the first) stays in view; the rest wait under ⋯.
 */
export function resolveHappierSelectionActionBarLayout(input: Readonly<{
  actions: readonly HappierSelectionActionBarAction[];
  containerWidth: number;
  naturalWidth: number;
}>): HappierSelectionActionBarLayout {
  const folded = input.containerWidth > 0
    && input.naturalWidth > 0
    && input.naturalWidth > input.containerWidth
    && input.actions.length > 1;
  if (!folded) return { folded: false, inline: input.actions, overflow: [] };
  const kept = input.actions.find((action) => action.emphasis === 'primary') ?? input.actions[0]!;
  return {
    folded: true,
    inline: [kept],
    overflow: input.actions.filter((action) => action !== kept),
  };
}

/** The pill's measures (collab lab D1 `.cb-selbar`): 12 radius, 4 inset, 30-tall actions, 2 apart. */
const BAR_RADIUS = 12;
const BAR_INSET = 4;
const ACTION_HEIGHT = 32;
const ACTION_RADIUS = 8;
const ACTION_GAP = 2;
const PRIMARY_FILL_OPACITY = 0.14;
const DIVIDER_OPACITY = 0.2;
const GLYPH_SIZE = 14;
const ENTER_OFFSET_Y = 8;

const labelTextStyle: HappierPortableStyle = { fontSize: 13, lineHeight: 18, fontWeight: '600' };
const actionTextStyle: HappierPortableStyle = { fontSize: 13, lineHeight: 18, fontWeight: '500' };
const statusTextStyle: HappierPortableStyle = { fontSize: 12.5, lineHeight: 18 };

type Presented = Readonly<{
  label: string;
  labelAccessibilityLabel?: string;
  labelTestID?: string;
  status?: string | null;
  statusTestID?: string;
  actions: readonly HappierSelectionActionBarAction[];
  dismiss: HappierSelectionActionBarProps['dismiss'];
}>;

export function HappierSelectionActionBar(props: HappierSelectionActionBarProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  const reducedMotion = props.reducedMotion ?? accessibility?.reducedMotion ?? false;
  const [present, setPresent] = useState(props.visible);
  const presentedRef = useRef<Presented | null>(null);
  if (props.visible) {
    presentedRef.current = {
      label: props.label,
      labelAccessibilityLabel: props.labelAccessibilityLabel,
      labelTestID: props.labelTestID,
      status: props.status,
      statusTestID: props.statusTestID,
      actions: props.actions,
      dismiss: props.dismiss,
    };
  }
  const progress = useRef(new Animated.Value(props.visible ? 1 : 0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const [naturalWidth, setNaturalWidth] = useState(0);

  useEffect(() => {
    if (props.visible) setPresent(true);
    if (reducedMotion) {
      progress.setValue(props.visible ? 1 : 0);
      if (!props.visible) setPresent(false);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: props.visible ? 1 : 0,
      duration: HAPPIER_MOTION_V1.fastMs,
      useNativeDriver: false,
    });
    animation.start();
    // The bar leaves on the motion's own clock rather than on the animation callback, so the exit
    // lasts exactly the token's duration on every runtime.
    const exit = props.visible ? null : setTimeout(() => setPresent(false), HAPPIER_MOTION_V1.fastMs);
    return () => {
      animation.stop();
      if (exit !== null) clearTimeout(exit);
    };
  }, [progress, props.visible, reducedMotion]);

  const onContainerLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);
  const presented = present || props.visible ? presentedRef.current : null;
  const layout = resolveHappierSelectionActionBarLayout({
    actions: presented?.actions ?? [],
    containerWidth,
    naturalWidth,
  });
  const onPillLayout = useCallback((event: LayoutChangeEvent) => {
    // The natural width is read only while nothing is folded; a folded bar is narrower by design.
    if (!layout.folded) setNaturalWidth(event.nativeEvent.layout.width);
  }, [layout.folded]);

  if (!presented) return null;
  const { background, foreground } = props.colors;
  const Text = props.host.Text;
  const actionColor = (action: HappierSelectionActionBarAction) => (
    action.emphasis === 'destructive' && props.colors.destructive ? props.colors.destructive : foreground
  );

  return (
    <View
      onLayout={onContainerLayout}
      pointerEvents={props.visible ? 'box-none' : 'none'}
      style={[{ width: '100%', alignItems: layout.folded ? 'stretch' : 'center' }, props.style] as HappierStyleProp}
    >
      <Animated.View
        role="toolbar"
        aria-label={props.accessibilityLabel}
        accessibilityLabel={props.accessibilityLabel}
        testID={props.visible ? props.testID : undefined}
        onLayout={onPillLayout}
        style={{
          maxWidth: '100%',
          opacity: progress,
          transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [ENTER_OFFSET_Y, 0] }) }],
        }}
      >
        <HappierMaterialSurface materialRole="floating" finishRole="floating" nested={false} gradient={props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: layout.folded ? 'space-between' : 'flex-start', gap: ACTION_GAP,
          maxWidth: '100%', padding: BAR_INSET, borderRadius: BAR_RADIUS, backgroundColor: background,
        }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, flexShrink: 1, minWidth: 0 }}>
          <Text
            testID={presented.labelTestID}
            accessibilityLabel={presented.labelAccessibilityLabel}
            numberOfLines={1}
            tabularNumbers
            style={{ ...labelTextStyle, color: foreground }}
          >{presented.label}</Text>
          {presented.status ? (
            <Text testID={presented.statusTestID} numberOfLines={1} style={{ ...statusTextStyle, color: foreground, opacity: 0.72 }}>
              {presented.status}
            </Text>
          ) : null}
        </View>
        {layout.inline.length > 0 || layout.overflow.length > 0 ? (
          <View style={{ width: 1, height: 18, backgroundColor: foreground, opacity: DIVIDER_OPACITY, marginHorizontal: 2 }} />
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: ACTION_GAP }}>
          {layout.inline.map((action) => (
            <HappierPressable
              key={action.id}
              testID={action.testID}
              accessibilityLabel={action.accessibilityLabel ?? action.label}
              disabled={action.disabled}
              busy={action.busy}
              onPress={action.onPress}
              style={({ pressed }) => ({
                height: ACTION_HEIGHT,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 10,
                borderRadius: ACTION_RADIUS,
                overflow: 'hidden',
                opacity: action.disabled ? 0.45 : pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
              })}
            >
              {action.emphasis === 'primary' ? (
                <View
                  pointerEvents="none"
                  style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: foreground, opacity: PRIMARY_FILL_OPACITY }}
                />
              ) : null}
              {action.renderIcon?.(actionColor(action)) ?? null}
              <Text numberOfLines={1} style={{ ...actionTextStyle, color: actionColor(action) }}>{action.label}</Text>
            </HappierPressable>
          ))}
          {layout.overflow.length > 0 ? (
            <props.host.OverflowMenu
              accessibilityLabel={props.moreLabel ?? ''}
              items={layout.overflow.map((action) => ({
                id: action.id,
                label: action.label,
                disabled: action.disabled || action.busy,
                destructive: action.emphasis === 'destructive',
                testID: action.testID,
              }))}
              onSelect={(id) => { layout.overflow.find((action) => action.id === id)?.onPress(); }}
              renderTrigger={(open) => (
                <HappierPressable
                  accessibilityLabel={props.moreLabel}
                  hasPopup="menu"
                  onPress={open}
                  style={({ pressed }) => ({
                    height: ACTION_HEIGHT,
                    minWidth: ACTION_HEIGHT,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: ACTION_RADIUS,
                    opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
                  })}
                >
                  {props.host.renderGlyph('more', foreground, GLYPH_SIZE)}
                </HappierPressable>
              )}
            />
          ) : null}
          <HappierPressable
            testID={presented.dismiss.testID}
            accessibilityLabel={presented.dismiss.label}
            disabled={presented.dismiss.disabled}
            onPress={presented.dismiss.onPress}
            style={({ pressed }) => ({
              height: ACTION_HEIGHT,
              minWidth: ACTION_HEIGHT,
              paddingHorizontal: presented.dismiss.presentation === 'label' ? 10 : 0,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: ACTION_RADIUS,
              opacity: pressed ? HAPPIER_PRESS_FEEDBACK_V1.opacity : 1,
            })}
          >
            {presented.dismiss.presentation === 'label'
              ? <Text numberOfLines={1} style={{ ...actionTextStyle, color: foreground }}>{presented.dismiss.label}</Text>
              : props.host.renderGlyph('dismiss', foreground, GLYPH_SIZE)}
          </HappierPressable>
        </View>
        </HappierMaterialSurface>
      </Animated.View>
    </View>
  );
}
