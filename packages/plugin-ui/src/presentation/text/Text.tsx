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

import { useOptionalHappierUiAccessibility, useOptionalHappierUiTheme } from '../../environment/context.js';
import type { HappierPortableStyle, HappierStyleProp, HappierTextHostProps } from '../portableTypes.js';
import {
  HAPPIER_TONE_COLOR_TOKEN,
  type HappierTextVariant,
  type HappierTone,
} from '../semantics.js';
import { scaleTextStyleMetrics, type TextStyleEntryTransform } from './textStyleScale.js';
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
const TextSelectabilityContext = createContext<boolean>(false);


export type HappierTextSelectabilityScopeProps = Readonly<{
  selectable: boolean;
  children: ReactNode;
}>;

/**
 * Make every descendant text selectable (or not) without threading a prop.
 *
 * A nearer explicit `selectable` prop still wins, so a scope sets the default
 * for a region rather than overriding individual decisions.
 */
export function HappierTextSelectabilityScope({
  selectable,
  children,
}: HappierTextSelectabilityScopeProps) {
  return (
    <TextSelectabilityContext.Provider value={selectable}>
      {children}
    </TextSelectabilityContext.Provider>
  );
}

/** Facts shared by the portable primitive and core's private native adapter. */
export type HappierTextPresentation = Readonly<{
  /** The explicit prop wins over the nearest selection scope. */
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
  const selectableFromScope = useContext(TextSelectabilityContext);
  const scaleOwnership = resolveHappierTextScaleOwnership({
    ...(textScale === undefined ? {} : { explicitTextScale: textScale }),
    ...(environmentAccessibility === null
      ? {}
      : { environmentTextScale: environmentAccessibility.textScale }),
  });

  return useMemo(() => ({
    selectable: selectable ?? selectableFromScope,
    metricScale: scaleOwnership.metricScale,
    allowHostFontScaling: scaleOwnership.allowHostFontScaling,
  }), [
    selectable,
    selectableFromScope,
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
}>;

export const HappierText = memo(forwardRef<unknown, HappierTextProps>(function HappierText(
  {
    variant,
    tone,
    selectable,
    textScale,
    scaleStyleEntry,
    baseStyle,
    allowFontScaling,
    style,
    ...rest
  },
  ref,
) {
  const theme = useOptionalHappierUiTheme();
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

    const typography = variant ? theme.typography[variant] : undefined;
    const color = tone ? theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]] : undefined;
    return {
      ...(typography
        ? {
          fontSize: typography.fontSize,
          lineHeight: typography.lineHeight,
          ...('fontWeight' in typography ? { fontWeight: typography.fontWeight as TextStyle['fontWeight'] } : {}),
          ...('fontFamily' in typography && typography.fontFamily
            ? { fontFamily: typography.fontFamily }
            : {}),
        }
        : {}),
      ...(color ? { color } : {}),
    };
  }, [theme, variant, tone]);

  const scaleOptions = useMemo(
    () => (scaleStyleEntry ? { transformEntry: scaleStyleEntry } : {}),
    [scaleStyleEntry],
  );

  const mergedStyle = useMemo(() => {
    const entries: StyleProp<TextStyle>[] = [];
    if (baseStyle) entries.push(baseStyle);
    if (semanticStyle) entries.push(scaleTextStyleMetrics(semanticStyle, resolvedScale, scaleOptions));

    const scaled = scaleTextStyleMetrics(style, resolvedScale, scaleOptions);
    // Flattened rather than nested so the caller's own entries keep the exact
    // cascade order Happier core has always produced.
    if (Array.isArray(scaled)) entries.push(...(scaled as StyleProp<TextStyle>[]));
    else if (scaled) entries.push(scaled as StyleProp<TextStyle>);

    return entries;
  }, [baseStyle, semanticStyle, style, resolvedScale, scaleOptions]);

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
