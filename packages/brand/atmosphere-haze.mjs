import Color from 'color';

/** Glass owns blur radii; atmosphere owns the two scene-copy masks. */
export function wallpaperHazeLayers(radii) {
  return [
    { blur: radii.regular, rx: 0.4, ry: 0.44, solid: 0.38 },
    { blur: radii.strong, rx: 0.3, ry: 0.34, solid: 0.3 },
  ];
}

export function picturePrefersPageInk(primary, page, picture) {
  const contrast = value => (Math.max(value, picture) + 0.05) / (Math.min(value, picture) + 0.05);
  return contrast(primary) < 3 && contrast(page) >= 4.5;
}

const greyOf = luminance => {
  const linear = Math.min(1, Math.max(0, luminance));
  const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Color.rgb(value * 255, value * 255, value * 255);
};

function veilColor(page, bandColor) {
  if (!bandColor) return page;
  const [lightness] = Color(page).lch().array();
  const [, chroma, hue] = Color(bandColor).lch().array();
  const shown = c => {
    const color = Color.lch(lightness, c, hue);
    const [l, back] = color.rgb().lch().array();
    return Math.abs(l - lightness) < 0.5 && Math.abs(back - c) < 0.5 ? color : null;
  };
  let low = 0, high = chroma;
  if (shown(high)) low = high;
  else for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (shown(middle)) low = middle; else high = middle;
  }
  return low < 2 ? page : shown(low).rgb().round().string();
}

/** The existing wallpaper legibility decision, shared by interactive and static paints. */
export function resolveWallpaperHaze(input) {
  const layers = input.layers;
  if (!input.adaptive || !input.heads) {
    const ink = input.fallbackInk ?? (input.heads && picturePrefersPageInk(
      Color(input.primary).luminosity(), Color(input.page).luminosity(), input.heads.focus,
    ) ? 'page' : 'theme');
    return { layers, veil: null, ink };
  }
  const ink = Color(input.primary), page = Color(input.page);
  const color = veilColor(input.page, input.bandColor), veil = Color(color);
  // Every ink the head lines carry holds AA: the primary and, when given, the quieter secondary.
  const inks = input.secondary ? [ink, Color(input.secondary)] : [ink];
  const worst = greyOf(page.luminosity() > ink.luminosity() ? input.heads.dark : input.heads.light);
  const holds = alpha => inks.every(each => each.contrast(worst.mix(veil, alpha)) >= 4.5 * 1.03);
  if (holds(0)) return { layers, veil: null, ink: 'theme' };
  let low = 0, high = 1;
  for (let step = 0; step < 20; step++) {
    const middle = (low + high) / 2;
    if (holds(middle)) high = middle; else low = middle;
  }
  const core = layers[0];
  const widen = Math.max(1, Math.hypot(input.column.x / core.rx, input.column.y / core.ry) / core.solid);
  return { layers,
    veil: { color, alpha: Math.ceil(high * 1000) / 1000, at: input.at,
      rx: core.rx * widen, ry: core.ry * widen, solid: core.solid }, ink: 'theme' };
}
