import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import {
  Text as ReactNativeText,
  type StyleProp,
  type TextStyle,
} from 'react-native';

import {
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiTheme,
  useOptionalHappierUiTypography,
} from '../../environment/context.js';
import type { HappierPortableStyle, HappierStyleProp, HappierTextHostProps } from '../portableTypes.js';
import {
  HAPPIER_TONE_COLOR_TOKEN,
  type HappierTextVariant,
  type HappierTone,
} from '../semantics.js';
import { scaleTextStyleMetrics, type TextStyleEntryTransform } from './textStyleScale.js';
import { readHappierTypeRoleTabular, resolveHappierTypeRoleStyle } from './typeRole.js';
import type { HappierTypeEmphasis } from './typeScale.js';

const TABULAR_NUMBERS_STYLE: TextStyle = { fontVariant: ['tabular-nums'] };
import { resolveHappierTextScaleOwnership } from './textScaleOwnership.js';

/**
 * The single implementation owner for Happier text (UI-T27).
 *
 * `@happier-dev/plugin-ui` renders this portable primitive, while Happier core
 * consumes {@link useHappierTextPresentation} before applying its private
 * React Native props and Unistyles entries to an app-owned host. They differ
 * only in how they acquire facts: core injects its resolved `uiFontScale` local
 * setting and its Unistyles style entries, a plugin surface reads the projected
 * environment. Neither owns a second copy of the scaling or selectability
 * behaviour.
 *
 * Host requirement: because Happier core styles this component with Unistyles
 * entries, any host bundling this file must let the Unistyles Babel plugin
 * process it (`autoProcessPaths` in `apps/ui/babel.config.js`). Untouched, the
 * `react-native` import below stays a raw host component that silently drops
 * every `unistyles_*` style, collapsing app-wide text to the react-native-web
 * 14px/400 default.
 */
const TextSelectabilityContext = createContext<Readonly<{
  selectable: boolean;
  suppressed: boolean;
}>>({ selectable: false, suppressed: false });


export type HappierTextSelectabilityScopeProps = Readonly<{
  selectable?: boolean;
  /** Prevent native selection from competing with a region's scroll gesture. */
  suppressSelection?: boolean;
  children: ReactNode;
}>;

/**
 * Make every descendant text selectable (or not) without threading a prop.
 *
 * Explicit text props override the default. Suppression overrides selection
 * throughout a region, including nested defaults, so native long presses cannot
 * steal its horizontal scroll gesture.
 */
export function HappierTextSelectabilityScope({
  selectable,
  suppressSelection = false,
  children,
}: HappierTextSelectabilityScopeProps) {
  const inherited = useContext(TextSelectabilityContext);
  const value = useMemo(() => ({
    selectable: selectable ?? inherited.selectable,
    suppressed: inherited.suppressed || suppressSelection,
  }), [inherited.selectable, inherited.suppressed, selectable, suppressSelection]);
  return (
    <TextSelectabilityContext.Provider value={value}>
      {children}
    </TextSelectabilityContext.Provider>
  );
}

/** Shared selectability policy for plain and enriched native text adapters. */
export function useHappierTextSelectability(selectable?: boolean): boolean {
  const scope = useContext(TextSelectabilityContext);
  return !scope.suppressed && (selectable ?? scope.selectable);
}

/** Facts shared by the portable primitive and core's private native adapter. */
export type HappierTextPresentation = Readonly<{
  /** Explicit props override defaults unless selection is suppressed by a scope. */
  selectable: boolean;
  /** The resolved scale for manually scaled style metrics. */
  metricScale: number;
  /** Whether the native host may apply a second accessibility scale. */
  allowHostFontScaling: boolean;
}>;

export type HappierTextPresentationInput = Readonly<{
  selectable?: boolean;
  textScale?: number;
}>;

/**
 * Resolve the text behavior that must remain identical when a host needs a
 * private native text prop or style outside the portable author contract.
 */
export function useHappierTextPresentation({
  selectable,
  textScale,
}: HappierTextPresentationInput): HappierTextPresentation {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const resolvedSelectable = useHappierTextSelectability(selectable);
  const scaleOwnership = resolveHappierTextScaleOwnership({
    ...(textScale === undefined ? {} : { explicitTextScale: textScale }),
    ...(environmentAccessibility === null
      ? {}
      : { environmentTextScale: environmentAccessibility.textScale }),
  });

  return useMemo(() => ({
    selectable: resolvedSelectable,
    metricScale: scaleOwnership.metricScale,
    allowHostFontScaling: scaleOwnership.allowHostFontScaling,
  }), [
    resolvedSelectable,
    scaleOwnership.allowHostFontScaling,
    scaleOwnership.metricScale,
  ]);
}

export type HappierTextProps = HappierTextHostProps & Readonly<{
  /**
   * Semantic typography role, resolved from the environment theme. Omit it when
   * the caller supplies its own typography through {@link baseStyle} — Happier
   * core does exactly that, because its typography owner is Unistyles.
   */
  variant?: HappierTextVariant;
  /**
   * The role's weight for the one value a row is read by (a vital's figure beside its label); the role keeps
   * its size and line height. Applies with `variant`.
   */
  emphasis?: HappierTypeEmphasis;
  /** Semantic colour role, resolved from the environment theme. */
  tone?: HappierTone;
  /** Defaults to the nearest {@link HappierTextSelectabilityScope}. */
  selectable?: boolean;
  /**
   * The resolved UI text scale.
   *
   * Injected rather than read from a store (§3.10.2): Happier core owns the
   * `uiFontScale` local setting, a plugin surface receives `textScale` in its
   * projected context. When omitted the environment value is used, and when
   * there is no environment the text is unscaled.
   */
  textScale?: number;
  /**
   * A style-system hook applied to each plain style entry before its metrics are
   * scaled. Happier core passes its Unistyles secret unwrapper; external authors
   * never need it.
   */
  scaleStyleEntry?: TextStyleEntryTransform;
  /**
   * Caller-owned default typography applied UNDER `style`.
   *
   * It is deliberately not scaled here: the adapter that produced it owns its
   * scaling, which is what keeps Happier core's existing behaviour byte-for-byte
   * (its default typography carries no metrics to scale).
   */
  baseStyle?: HappierStyleProp;
  /** Web focus-order override forwarded to the underlying host element. */
  tabIndex?: 0 | -1;
  /**
   * Draw digits at a fixed advance so changing counts, ages and times never
   * jitter. A variant whose host role is tabular gets it without asking.
   */
  tabularNumbers?: boolean;
}>;

export const HappierText = memo(forwardRef<unknown, HappierTextProps>(function HappierText(
  {
    variant,
    emphasis,
    tone,
    selectable,
    textScale,
    scaleStyleEntry,
    baseStyle,
    allowFontScaling,
    style,
    tabularNumbers,
    ...rest
  },
  ref,
) {
  const theme = useOptionalHappierUiTheme();
  const hostTypography = useOptionalHappierUiTypography();
  const presentation = useHappierTextPresentation({ selectable, textScale });
  const resolvedScale = presentation.metricScale;

  const semanticStyle = useMemo<HappierPortableStyle | null>(() => {
    if (variant === undefined && tone === undefined) return null;
    if (!theme) {
      throw new Error(
        'Happier UI Text was given a semantic variant or tone with no theme in scope. '
        + 'Wrap the surface in PluginUiProvider (plugin) or the Happier UI environment (core), '
        + 'or style the text directly instead.',
      );
    }

    const color = tone ? theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]] : undefined;
    const code = variant === 'code' ? theme.typography.code : undefined;
    return {
      ...(variant === undefined
        ? {}
        : code
          ? {
            fontSize: code.fontSize,
            lineHeight: code.lineHeight,
            ...(code.fontFamily ? { fontFamily: code.fontFamily } : {}),
          }
          : resolveHappierTypeRoleStyle(variant as Exclude<HappierTextVariant, 'code'>, theme, hostTypography, emphasis)),
      ...(color ? { color } : {}),
    };
  }, [theme, hostTypography, variant, emphasis, tone]);

  const tabular = tabularNumbers === true
    || (variant !== undefined && variant !== 'code' && readHappierTypeRoleTabular(variant, hostTypography));

  const scaleOptions = useMemo(
    () => (scaleStyleEntry ? { transformEntry: scaleStyleEntry } : {}),
    [scaleStyleEntry],
  );

  const mergedStyle = useMemo(() => {
    const entries: StyleProp<TextStyle>[] = [];
    if (baseStyle) entries.push(baseStyle);
    if (semanticStyle) entries.push(scaleTextStyleMetrics(semanticStyle, resolvedScale, scaleOptions));

    if (tabular) entries.push(TABULAR_NUMBERS_STYLE);

    const scaled = scaleTextStyleMetrics(style, resolvedScale, scaleOptions);
    // Flattened rather than nested so the caller's own entries keep the exact
    // cascade order Happier core has always produced.
    if (Array.isArray(scaled)) entries.push(...(scaled as StyleProp<TextStyle>[]));
    else if (scaled) entries.push(scaled as StyleProp<TextStyle>);

    return entries;
  }, [baseStyle, semanticStyle, tabular, style, resolvedScale, scaleOptions]);

  return (
    <ReactNativeText
      ref={ref as never}
      style={mergedStyle}
      selectable={presentation.selectable}
      {...rest}
      allowFontScaling={allowFontScaling ?? presentation.allowHostFontScaling}
    />
  );
}));
