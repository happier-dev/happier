import type { HappierStyleProp } from '../portableTypes.js';

/**
 * The portable half of Happier's UI text scaling, extracted from
 * `apps/ui/sources/components/ui/text/uiFontScale.ts` (§3.10.3 step 2).
 *
 * What graduated: the traversal over nested style arrays, the own-property
 * preserving clone, and the numeric metric scaling with its rounding rule.
 *
 * What stayed behind in the app adapter: Unistyles secret unwrapping
 * (`unistyles_*` keys and `uni__getStyles`). Unistyles runtime objects are
 * private product infrastructure (§3.10.8) and an external author never produces
 * one. The app plugs its style system back in through {@link transformEntry}.
 */
/**
 * A style-system transform may clone or wrap values, but it must retain the
 * entry's generic shape. The scaler preserves the caller's container and
 * opaque-field shape, so a transform that replaces an opaque host entry with
 * an unrelated object would make that contract false.
 */
export type TextStyleEntryTransform = <T extends object>(entry: T, textScale: number) => T;

export type ScaleTextStyleOptions = Readonly<{
  /**
   * Applied to every plain-object style entry BEFORE its numeric metrics are
   * scaled, so a style system whose values are computed lazily can wrap its own
   * resolver. The transform must retain the entry's generic shape, so opaque
   * host metadata remains present after traversal. Defaults to identity — plain
   * React Native styles need nothing.
   */
  transformEntry?: TextStyleEntryTransform;
}>;

type ScaledTextMetricKey = 'fontSize' | 'lineHeight' | 'letterSpacing';

type ScaleTextMetricValue<Value> = Value extends number ? number : Value;

type IsExactly<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;

type ScaledTextStyleArray<T extends readonly unknown[]> = number extends T['length']
  ? T extends unknown[]
    ? ScaledTextStyleMetrics<T[number]>[]
    : readonly ScaledTextStyleMetrics<T[number]>[]
  : { [Index in keyof T]: ScaledTextStyleMetrics<T[Index]> };

/**
 * The scaler retains each style container and opaque entry field, while making
 * the values it can numerically change truthful at the type boundary. Tuple
 * and readonly shapes stay precise without recursively mapping Array prototype
 * methods.
 */
export type ScaledTextStyleMetrics<T> = IsExactly<T, HappierStyleProp> extends true
  ? HappierStyleProp
  : T extends readonly unknown[]
    ? ScaledTextStyleArray<T>
    : T extends object
      ? {
        [Key in keyof T]: Key extends ScaledTextMetricKey
          ? ScaleTextMetricValue<T[Key]>
          : T[Key]
      }
      : T;

function roundTo2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Clone preserving own property descriptors and prototype.
 *
 * A plain spread would drop non-enumerable and accessor properties that a style
 * system may attach to its style objects, so the scaled copy must keep them.
 */
export function cloneStyleEntryPreservingOwnProps<T extends object>(entry: T): T {
  try {
    return Object.create(Object.getPrototypeOf(entry), Object.getOwnPropertyDescriptors(entry)) as T;
  } catch {
    return { ...entry };
  }
}

function scaleNumericTextMetrics(entry: unknown, textScale: number): unknown {
  const candidate = entry as { fontSize?: unknown; lineHeight?: unknown; letterSpacing?: unknown } | null;
  const hasFontSize = typeof candidate?.fontSize === 'number';
  const hasLineHeight = typeof candidate?.lineHeight === 'number';
  const hasLetterSpacing = typeof candidate?.letterSpacing === 'number';
  if (!hasFontSize && !hasLineHeight && !hasLetterSpacing) return entry;

  const next = cloneStyleEntryPreservingOwnProps(entry as object) as Record<string, unknown>;
  try {
    if (hasFontSize) next.fontSize = roundTo2((candidate!.fontSize as number) * textScale);
    if (hasLineHeight) next.lineHeight = roundTo2((candidate!.lineHeight as number) * textScale);
    if (hasLetterSpacing) next.letterSpacing = roundTo2((candidate!.letterSpacing as number) * textScale);
    return next;
  } catch {
    return entry;
  }
}

function scaleEntry(entry: unknown, textScale: number, options: ScaleTextStyleOptions): unknown {
  if (!entry) return entry;
  if (Array.isArray(entry)) {
    let changed = false;
    const next = entry.map((nested) => {
      const scaled = scaleEntry(nested, textScale, options);
      if (scaled !== nested) changed = true;
      return scaled;
    });
    return changed ? next : entry;
  }
  if (typeof entry !== 'object') return entry;

  const transformed = options.transformEntry
    ? options.transformEntry(entry as object, textScale)
    : entry;
  return scaleNumericTextMetrics(transformed, textScale);
}

/**
 * Scale the numeric text metrics of a React Native text style.
 *
 * Identity is preserved when nothing changes, so a memoized consumer does not
 * rerender because a style was walked. A scale of exactly `1`, or a
 * non-finite scale, returns the input untouched. The return type retains every
 * opaque field and container shape, but widens numerically scaled metric
 * literals to `number`.
 */
export function scaleTextStyleMetrics<T>(
  style: T,
  textScale: number,
  options: ScaleTextStyleOptions = {},
): ScaledTextStyleMetrics<T> {
  if (style == null) return style as ScaledTextStyleMetrics<T>;
  if (typeof textScale !== 'number' || !Number.isFinite(textScale) || textScale === 1) {
    return style as ScaledTextStyleMetrics<T>;
  }
  return scaleEntry(style, textScale, options) as ScaledTextStyleMetrics<T>;
}
