import Color from 'color';

/**
 * The browser is the boundary that applies a CSS `backdrop-filter` and composites the coat over it.
 * This mirrors that math (Filter Effects shorthands in sRGB, clamped per function, then source-over
 * of the coat) so glass tests can assert rendered colours rather than CSS spellings.
 */
type Rgb = readonly [number, number, number];

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function applyFilterFunction(rgb: Rgb, name: string, amount: number): Rgb {
  if (name === 'blur') return rgb;
  if (name === 'brightness')
    return rgb.map((v) => clamp(v * amount)) as unknown as Rgb;
  if (name === 'contrast')
    return rgb.map((v) => clamp((v - 0.5) * amount + 0.5)) as unknown as Rgb;
  if (name === 'invert')
    return rgb.map((v) =>
      clamp(amount * (1 - v) + (1 - amount) * v),
    ) as unknown as Rgb;
  if (name === 'saturate') {
    const s = amount;
    const [r, g, b] = rgb;
    return [
      clamp(
        (0.213 + 0.787 * s) * r +
          (0.715 - 0.715 * s) * g +
          (0.072 - 0.072 * s) * b,
      ),
      clamp(
        (0.213 - 0.213 * s) * r +
          (0.715 + 0.285 * s) * g +
          (0.072 - 0.072 * s) * b,
      ),
      clamp(
        (0.213 - 0.213 * s) * r +
          (0.715 - 0.715 * s) * g +
          (0.072 + 0.928 * s) * b,
      ),
    ];
  }
  throw new Error(`unsupported filter function ${name}`);
}

/** Applies a backdrop-filter string to an sRGB colour in 0–255. */
export function applyGlassBackdropFilter(filter: string, backdrop: Rgb): Rgb {
  let rgb = backdrop.map((v) => v / 255) as unknown as Rgb;
  for (const match of filter.matchAll(
    /([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
  )) {
    const amount = Number.parseFloat(match[2]!);
    rgb = applyFilterFunction(
      rgb,
      match[1]!,
      Number.isFinite(amount) ? amount : 1,
    );
  }
  return rgb.map((v) => v * 255) as unknown as Rgb;
}

/** The rendered glass colour: filtered backdrop with the coat (0–255, opacity 0–1) composited over it. */
export function renderGlassOver(
  input: Readonly<{
    filter: string;
    coat: Rgb;
    opacity: number;
    backdrop: Rgb;
  }>,
): Rgb {
  const filtered = applyGlassBackdropFilter(input.filter, input.backdrop);
  return filtered.map(
    (v, i) => v * (1 - input.opacity) + input.coat[i]! * input.opacity,
  ) as unknown as Rgb;
}

/** WCAG contrast ratio between two sRGB colours in 0–255. */
export function glassContrastRatio(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, b2] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b2!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// JSDOM retains CSS variables and color-mix. Resolve the emitted browser paint boundary.
export function resolveBrowserMaterialPaint(input: string, variables: Readonly<Record<string, string>> = {}): string {
    const split = (value: string) => {
        let depth = 0;
        for (let i = 0; i < value.length; i++) {
            if (value[i] === '(') depth++;
            if (value[i] === ')') depth--;
            if (value[i] === ',' && depth === 0) return [value.slice(0, i).trim(), value.slice(i + 1).trim()];
        }
        return [value.trim(), ''];
    };
    let value = input;
    while (value.includes('var(')) {
        const start = value.lastIndexOf('var(');
        let end = start + 4, depth = 1;
        for (; depth > 0 && end < value.length; end++) {
            if (value[end] === '(') depth++;
            if (value[end] === ')') depth--;
        }
        end--;
        const [key, fallback] = split(value.slice(start + 4, end));
        const published = (variables[key!] ?? globalThis.document?.documentElement.style.getPropertyValue(key!) ?? '').trim();
        value = value.slice(0, start) + (published && published !== 'initial' ? published : fallback) + value.slice(end + 1);
    }
    if (value.startsWith('color-mix(in srgb, ')) {
        const [first, second] = split(value.slice(19, -1));
        const match = /^(.*) ([\d.]+)%$/.exec(first!);
        if (!match) throw new Error('Unsupported material color-mix');
        if (match[2] === '0' || match[2] === '100') {
            return resolveBrowserMaterialPaint(match[2] === '100' ? match[1]! : second!, variables);
        }
        if (second !== 'transparent') throw new Error('Unsupported material color-mix');
        const color = Color(resolveBrowserMaterialPaint(match[1]!, variables));
        return color.alpha(color.alpha() * Number(match[2]) / 100).hexa();
    }
    return Color(value).hexa();
}
