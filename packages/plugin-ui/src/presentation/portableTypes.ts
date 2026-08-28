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
  borderBottomColor?: string;
  borderBottomLeftRadius?: number | string;
  borderBottomRightRadius?: number | string;
  borderBottomWidth?: number;
  borderColor?: string;
  borderLeftColor?: string;
  borderLeftWidth?: number;
  borderRadius?: number | string;
  borderRightColor?: string;
  borderRightWidth?: number;
  borderStyle?: 'solid' | 'dotted' | 'dashed';
  borderTopColor?: string;
  borderTopLeftRadius?: number | string;
  borderTopRightRadius?: number | string;
  borderTopWidth?: number;
  borderWidth?: number;
  bottom?: HappierDimension;
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
  top?: HappierDimension;
  userSelect?: 'auto' | 'none' | 'text' | 'contain' | 'all';
  verticalAlign?: 'auto' | 'top' | 'bottom' | 'middle';
  width?: HappierDimension;
  writingDirection?: 'auto' | 'ltr' | 'rtl';
  zIndex?: number;
}>;

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
  accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
  accessibilityRole?: 'alert' | 'header' | 'link' | 'none' | 'text';
  allowFontScaling?: boolean;
  ellipsizeMode?: 'clip' | 'head' | 'middle' | 'tail';
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
