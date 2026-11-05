import type { ReactNode } from 'react';

/**
 * Framework-neutral declaration shapes for the public presentation contract.
 *
 * Implementations still render real React Native hosts and compile against the
 * owning `react-native` package. Public declarations cannot import that runtime,
 * however: it is a host-provided singleton and hosted-web/declarative authors do
 * not install a second copy merely to typecheck `@happier-dev/plugin-ui`.
 */

export type HappierAlignment =
  | 'baseline'
  | 'center'
  | 'flex-end'
  | 'flex-start'
  | 'stretch';

export type HappierJustification =
  | 'center'
  | 'flex-end'
  | 'flex-start'
  | 'space-around'
  | 'space-between'
  | 'space-evenly';

export type HappierDimension = number | `${number}%` | 'auto';

/** The native/RNW accessibility vocabulary without importing either renderer. */
export type HappierAccessibilityRole =
  | 'none' | 'button' | 'togglebutton' | 'link' | 'search' | 'image' | 'keyboardkey'
  | 'text' | 'adjustable' | 'imagebutton' | 'header' | 'summary' | 'alert' | 'checkbox'
  | 'combobox' | 'menu' | 'menubar' | 'menuitem' | 'progressbar' | 'radio' | 'radiogroup'
  | 'scrollbar' | 'spinbutton' | 'switch' | 'tab' | 'tabbar' | 'tablist' | 'timer' | 'list' | 'toolbar';

export type HappierAccessibilityState = Readonly<{
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | 'mixed';
  busy?: boolean;
  expanded?: boolean;
}>;

export type HappierFontWeight =
  | 'normal'
  | 'bold'
  | '100'
  | '200'
  | '300'
  | '400'
  | '500'
  | '600'
  | '700'
  | '800'
  | '900'
  | 'ultralight'
  | 'thin'
  | 'light'
  | 'medium'
  | 'regular'
  | 'semibold'
  | 'condensedBold'
  | 'condensed'
  | 'heavy'
  | 'black'
  | 100
  | 200
  | 300
  | 400
  | 500
  | 600
  | 700
  | 800
  | 900;

/**
 * The curated style vocabulary shared by the graduated RN/RNW components.
 *
 * This is deliberately structural and package-owned: external declarations do
 * not import the host's singleton `react-native` package, while unsupported CSS
 * and renderer-private style fields fail at author compile time. Add a property
 * only with a real shared component consumer and RN/RNW proof.
 */
export type HappierPortableStyle = Readonly<{
  alignContent?: 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: HappierAlignment;
  alignSelf?: 'auto' | HappierAlignment;
  aspectRatio?: number | string;
  backgroundColor?: string;
  /** Web surface paint only; native draws through the shared gradient layer. */
  backgroundImage?: string;
  backgroundClip?: 'padding-box';
  /** Web-only extent of `backgroundImage` layers (comma-separated per layer). */
  backgroundSize?: string;
  backgroundPosition?: string;
  backgroundRepeat?: string;
  borderBottomColor?: string;
  borderBottomLeftRadius?: number | string;
  borderBottomRightRadius?: number | string;
  borderBottomStartRadius?: number | string;
  borderBottomEndRadius?: number | string;
  borderBottomWidth?: number;
  borderColor?: string;
  borderLeftColor?: string;
  borderLeftWidth?: number;
  borderRadius?: number | string;
  borderRightColor?: string;
  borderRightWidth?: number;
  borderStartWidth?: number;
  borderEndWidth?: number;
  borderStyle?: 'solid' | 'dotted' | 'dashed';
  borderTopColor?: string;
  borderTopLeftRadius?: number | string;
  borderTopRightRadius?: number | string;
  borderTopStartRadius?: number | string;
  borderTopEndRadius?: number | string;
  borderTopWidth?: number;
  borderWidth?: number;
  bottom?: HappierDimension;
  /** A CSS box shadow (RN 0.76+ and RNW): the work-status halo (`resolveHappierWorkStatusSurfaceStyle`). */
  boxShadow?: string;
  color?: string;
  columnGap?: number | string;
  cursor?: 'auto' | 'pointer';
  direction?: 'inherit' | 'ltr' | 'rtl';
  display?: 'none' | 'flex' | 'contents';
  elevation?: number;
  flex?: number;
  flexBasis?: HappierDimension;
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  flexGrow?: number;
  flexShrink?: number;
  flexWrap?: 'wrap' | 'nowrap' | 'wrap-reverse';
  fontFamily?: string;
  fontSize?: number;
  fontStyle?: 'normal' | 'italic';
  fontWeight?: HappierFontWeight;
  gap?: number | string;
  height?: HappierDimension;
  includeFontPadding?: boolean;
  justifyContent?: HappierJustification;
  left?: HappierDimension;
  letterSpacing?: number;
  lineHeight?: number;
  margin?: HappierDimension;
  marginBottom?: HappierDimension;
  marginHorizontal?: HappierDimension;
  marginLeft?: HappierDimension;
  marginRight?: HappierDimension;
  marginTop?: HappierDimension;
  marginVertical?: HappierDimension;
  maxHeight?: HappierDimension;
  maxWidth?: HappierDimension;
  minHeight?: HappierDimension;
  minWidth?: HappierDimension;
  opacity?: number;
  overflow?: 'visible' | 'hidden' | 'scroll';
  padding?: HappierDimension;
  paddingBottom?: HappierDimension;
  paddingHorizontal?: HappierDimension;
  paddingLeft?: HappierDimension;
  paddingRight?: HappierDimension;
  paddingTop?: HappierDimension;
  paddingVertical?: HappierDimension;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
  position?: 'absolute' | 'relative' | 'static';
  right?: HappierDimension;
  rowGap?: number | string;
  shadowColor?: string;
  shadowOffset?: Readonly<{ width: number; height: number }>;
  shadowOpacity?: number;
  shadowRadius?: number;
  textAlign?: 'auto' | 'left' | 'right' | 'center' | 'justify';
  textAlignVertical?: 'auto' | 'top' | 'bottom' | 'center';
  textDecorationColor?: string;
  textDecorationLine?: 'none' | 'underline' | 'line-through' | 'underline line-through';
  textDecorationStyle?: 'solid' | 'double' | 'dotted' | 'dashed';
  textShadowColor?: string;
  textShadowOffset?: Readonly<{ width: number; height: number }>;
  textShadowRadius?: number;
  textTransform?: 'none' | 'capitalize' | 'uppercase' | 'lowercase';
  /** Web only (RNW passes it to CSS): `HAPPIER_BALANCED_TEXT_WRAP`'s even two-line split. */
  textWrap?: 'balance';
  top?: HappierDimension;
  /** The numeric placement tracks shared by Collection motion and floating frames. */
  transform?: Array<{ translateX: number } | { translateY: number }>;
  userSelect?: 'auto' | 'none' | 'text' | 'contain' | 'all';
  verticalAlign?: 'auto' | 'top' | 'bottom' | 'middle';
  /** Web only: keep a capability's machine name whole when its consequence sentence wraps. */
  whiteSpace?: 'nowrap';
  width?: HappierDimension;
  writingDirection?: 'auto' | 'ltr' | 'rtl';
  zIndex?: number;
}>;

/**
 * A style a shared owner layers onto a host's own style (a raised edge and its lift, a focus ring). It
 * never decides the element's overflow, so it spreads into any host stylesheet whose overflow vocabulary
 * is narrower than the portable one.
 */
export type HappierPortableLayerStyle = Omit<HappierPortableStyle, 'overflow'>;

export type HappierStyleProp =
  | HappierPortableStyle
  | false
  | null
  | undefined
  | HappierStyleProp[];

export type HappierAccessibilityLiveRegion = 'none' | 'polite' | 'assertive';

export type HappierFocusable = Readonly<{
  focus: () => void;
}>;

export type HappierGestureResponderEvent = Readonly<{
  nativeEvent: unknown;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}>;

export type HappierLayoutChangeEvent = Readonly<{
  nativeEvent: Readonly<{
    layout: Readonly<{ x: number; y: number; width: number; height: number }>;
  }>;
}>;

export type HappierScrollEvent = Readonly<{
  nativeEvent: unknown;
}>;

/** A caret (`start === end`) or a selected range inside a text control. */
export type HappierTextSelection = Readonly<{
  start: number;
  end: number;
}>;

export type HappierKeyboardShouldPersistTaps = boolean | 'always' | 'never' | 'handled';

export type HappierTextHostProps = Readonly<{
  children?: ReactNode;
  style?: HappierStyleProp;
  accessible?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityElementsHidden?: boolean;
  accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
  accessibilityRole?: 'alert' | 'header' | 'link' | 'none' | 'text';
  allowFontScaling?: boolean;
  ellipsizeMode?: 'clip' | 'head' | 'middle' | 'tail';
  importantForAccessibility?: 'auto' | 'yes' | 'no' | 'no-hide-descendants';
  maxFontSizeMultiplier?: number | null;
  nativeID?: string;
  numberOfLines?: number;
  onLayout?: (event: HappierLayoutChangeEvent) => void;
  onLongPress?: (event?: HappierGestureResponderEvent) => void;
  onPress?: (event?: HappierGestureResponderEvent) => void;
  selectable?: boolean;
  suppressHighlighting?: boolean;
  testID?: string;
}>;

export type HappierActivityIndicatorHostProps = Readonly<{
  'aria-hidden'?: boolean;
  accessibilityElementsHidden?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: 'progressbar';
  animating?: boolean;
  color?: string;
  hidesWhenStopped?: boolean;
  importantForAccessibility?: 'auto' | 'yes' | 'no' | 'no-hide-descendants';
  size?: 'small' | 'large' | number;
  style?: HappierStyleProp;
  testID?: string;
}>;
