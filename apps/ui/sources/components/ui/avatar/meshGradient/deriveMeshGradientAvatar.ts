import { createSeededRandom, hashStringToPositiveInt, pickSeeded } from '../avatarHash';
import { pickMeshGradientPatternVariant } from './meshGradientPatternVariant';
import type {
    MeshGradientAvatarModel,
    MeshGradientColorField,
    MeshGradientDepthField,
    MeshGradientPatternVariant,
    MeshGradientThemeInput,
    MeshGradientWaveField,
} from './meshGradientTypes';

type RgbColor = Readonly<{ r: number; g: number; b: number }>;

type DeriveMeshGradientAvatarParams = Readonly<{
    id: string;
    size: number;
    monochrome: boolean;
    theme: MeshGradientThemeInput;
    patternVariant?: MeshGradientPatternVariant;
}>;

const COLOR_FIELD_MIN_COUNT = 8;
const COLOR_FIELD_COUNT_VARIANCE = 3;
const WAVE_FIELD_COUNT = 2;
const DARK_THEME_LUMINANCE_THRESHOLD = 80;
const DARK_LIFTED_NEUTRAL_MIX = 0.96;
const DARK_GROUNDED_NEUTRAL_MIX = 0.92;
const DARK_ACCENT_NEUTRAL_BOOST = 0.04;
const LIGHT_LIFTED_NEUTRAL_DARKEN = 0.08;
const LIGHT_GROUNDED_NEUTRAL_DARKEN = 0.08;
const DEPTH_DARKEN_MIX = 0.56;
const DEPTH_ALPHA = 0.28;
const HIGHLIGHT_ALPHA = 0.24;
const COLOR_FIELD_JITTER = 0.14;
const COLOR_FIELD_RADIUS_MIN = 0.68;
const COLOR_FIELD_RADIUS_VARIANCE = 0.28;
const COLOR_FIELD_OPACITY_MIN = 0.72;
const COLOR_FIELD_OPACITY_VARIANCE = 0.12;
const COLOR_FIELD_ANCHORS = [
    [0.16, 0.16],
    [0.5, 0.14],
    [0.84, 0.16],
    [0.16, 0.5],
    [0.52, 0.5],
    [0.84, 0.5],
    [0.16, 0.84],
    [0.5, 0.86],
    [0.84, 0.84],
    [0.5, 0.5],
] as const;

const PHOTO_GRADIENT_PALETTE_ROLE_FAMILIES = [
    ['teal', 'gold', 'forest', 'clay', 'cream', 'slate', 'rose', 'sage'],
    ['sky', 'coral', 'olive', 'lavender', 'sand', 'teal', 'clay', 'cream'],
    ['teal', 'gold', 'sky', 'rose', 'forest', 'sand', 'clay', 'lavender'],
    ['sage', 'sky', 'coral', 'gold', 'slate', 'cream', 'forest', 'rose'],
] as const;

type PhotoGradientPaletteRole = typeof PHOTO_GRADIENT_PALETTE_ROLE_FAMILIES[number][number];

const COOL_ANCHOR_PALETTE_ROLES: readonly PhotoGradientPaletteRole[] = ['teal', 'sky'];
const WARM_ANCHOR_PALETTE_ROLES: readonly PhotoGradientPaletteRole[] = ['gold', 'clay', 'coral', 'olive'];
const PRIMARY_PALETTE_ROLES: readonly PhotoGradientPaletteRole[] = [
    ...COOL_ANCHOR_PALETTE_ROLES,
    ...WARM_ANCHOR_PALETTE_ROLES,
    'sage',
    'forest',
];
const STRUCTURED_VISIBLE_PALETTE_ROLE_COUNT = 5;

function clampColorChannel(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(color: string): RgbColor | null {
    const normalized = color.trim();
    const shortHex = normalized.match(/^#([0-9a-fA-F]{3})$/);
    if (shortHex) {
        const [r, g, b] = shortHex[1].split('').map((part) => Number.parseInt(part + part, 16));
        return { r, g, b };
    }

    const longHex = normalized.match(/^#([0-9a-fA-F]{6})$/);
    if (!longHex) return null;

    const value = longHex[1];
    return {
        r: Number.parseInt(value.slice(0, 2), 16),
        g: Number.parseInt(value.slice(2, 4), 16),
        b: Number.parseInt(value.slice(4, 6), 16),
    };
}

function parseRgbColor(color: string): RgbColor | null {
    const match = color.trim().match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return {
        r: clampColorChannel(Number(match[1])),
        g: clampColorChannel(Number(match[2])),
        b: clampColorChannel(Number(match[3])),
    };
}

function parseColor(color: string): RgbColor | null {
    return parseHexColor(color) ?? parseRgbColor(color);
}

function formatRgb(color: RgbColor): string {
    return `rgb(${clampColorChannel(color.r)}, ${clampColorChannel(color.g)}, ${clampColorChannel(color.b)})`;
}

function formatRgba(color: RgbColor, alpha: number): string {
    return `rgba(${clampColorChannel(color.r)}, ${clampColorChannel(color.g)}, ${clampColorChannel(color.b)}, ${Math.max(0, Math.min(1, alpha))})`;
}

function toNeutralColor(color: string): string {
    const parsed = parseColor(color);
    if (!parsed) return color;
    const luminance = clampColorChannel(getColorLuminance(parsed));
    return formatRgb({ r: luminance, g: luminance, b: luminance });
}

function getColorLuminance(color: RgbColor): number {
    return (color.r * 0.299) + (color.g * 0.587) + (color.b * 0.114);
}

function isDarkThemeInput(theme: MeshGradientThemeInput): boolean {
    const surfaceColor = parseColor(theme.surface);
    return surfaceColor ? getColorLuminance(surfaceColor) < DARK_THEME_LUMINANCE_THRESHOLD : false;
}

function getAccentColor(theme: MeshGradientThemeInput, index: number, fallbackIndex: number): string {
    return theme.accentColors[index] ?? theme.accentColors[fallbackIndex] ?? theme.textSecondary;
}

function mixRgbColor(from: RgbColor, to: RgbColor, amount: number): RgbColor {
    const ratio = Math.max(0, Math.min(1, amount));
    return {
        r: from.r + ((to.r - from.r) * ratio),
        g: from.g + ((to.g - from.g) * ratio),
        b: from.b + ((to.b - from.b) * ratio),
    };
}

function mixColor(from: string, to: string, amount: number): string {
    const parsedFrom = parseColor(from);
    const parsedTo = parseColor(to);
    if (!parsedFrom || !parsedTo) return from;
    return formatRgb(mixRgbColor(parsedFrom, parsedTo, amount));
}

function darkenColor(color: string, amount: number): string {
    const parsed = parseColor(color);
    if (!parsed) return color;
    return formatRgb({
        r: parsed.r * (1 - amount),
        g: parsed.g * (1 - amount),
        b: parsed.b * (1 - amount),
    });
}

function withAlpha(color: string, alpha: number): string {
    const parsed = parseColor(color);
    return parsed ? formatRgba(parsed, alpha) : color;
}

function createDepthField(
    color: string,
    random: () => number,
    size: number,
): MeshGradientDepthField {
    const depthColor = darkenColor(color, DEPTH_DARKEN_MIX);
    return {
        cx: (0.02 + (random() * 0.46)) * size,
        cy: (0.5 + (random() * 0.42)) * size,
        radius: (0.94 + (random() * 0.24)) * size,
        color: withAlpha(depthColor, DEPTH_ALPHA),
        transparentColor: withAlpha(depthColor, 0),
    };
}

function createHighlightField(
    color: string,
    random: () => number,
    size: number,
): MeshGradientDepthField {
    return {
        cx: (0.48 + (random() * 0.42)) * size,
        cy: (0.04 + (random() * 0.42)) * size,
        radius: (0.46 + (random() * 0.28)) * size,
        color: withAlpha(color, HIGHLIGHT_ALPHA),
        transparentColor: withAlpha(color, 0),
    };
}

function uniqueColors(colors: readonly string[]): string[] {
    const result: string[] = [];
    for (const color of colors) {
        if (!color || result.includes(color)) continue;
        result.push(color);
    }
    return result;
}

function shufflePaletteRoles(
    roles: readonly PhotoGradientPaletteRole[],
    random: () => number,
): PhotoGradientPaletteRole[] {
    const shuffled = [...roles];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
}

function takePaletteRole(
    roles: PhotoGradientPaletteRole[],
    predicate: (role: PhotoGradientPaletteRole) => boolean,
): PhotoGradientPaletteRole | null {
    const index = roles.findIndex(predicate);
    if (index < 0) return null;
    const [role] = roles.splice(index, 1);
    return role ?? null;
}

function takePreferredPaletteRole(
    roles: PhotoGradientPaletteRole[],
    preferredRoles: readonly PhotoGradientPaletteRole[],
): PhotoGradientPaletteRole | null {
    for (const preferredRole of preferredRoles) {
        const role = takePaletteRole(roles, (candidate) => candidate === preferredRole);
        if (role) return role;
    }
    return null;
}

function orderPaletteRoles(
    family: readonly PhotoGradientPaletteRole[],
    random: () => number,
): PhotoGradientPaletteRole[] {
    const remaining = shufflePaletteRoles(family, random);
    const ordered: PhotoGradientPaletteRole[] = [];
    const firstAnchor = takePreferredPaletteRole(remaining, WARM_ANCHOR_PALETTE_ROLES);
    const secondAnchor = takePreferredPaletteRole(remaining, COOL_ANCHOR_PALETTE_ROLES);

    if (firstAnchor) ordered.push(firstAnchor);
    if (secondAnchor) ordered.push(secondAnchor);

    const warmSupport = takePreferredPaletteRole(remaining, WARM_ANCHOR_PALETTE_ROLES);
    if (warmSupport) ordered.push(warmSupport);

    while (ordered.length < 4 && remaining.length > 0) {
        const primaryRole = takePaletteRole(remaining, (role) => PRIMARY_PALETTE_ROLES.includes(role));
        const fallbackRole = primaryRole ?? remaining.shift();
        if (fallbackRole) ordered.push(fallbackRole);
    }

    return [...ordered, ...remaining];
}

function isSaturatedAnchorPaletteRole(role: PhotoGradientPaletteRole): boolean {
    return WARM_ANCHOR_PALETTE_ROLES.includes(role) || COOL_ANCHOR_PALETTE_ROLES.includes(role);
}

function varyStructuredVisiblePaletteRoles(
    roles: readonly PhotoGradientPaletteRole[],
    seed: number,
): PhotoGradientPaletteRole[] {
    const visible = roles.slice(0, STRUCTURED_VISIBLE_PALETTE_ROLE_COUNT);
    const remaining = roles.slice(STRUCTURED_VISIBLE_PALETTE_ROLE_COUNT);
    const random = createSeededRandom(hashStringToPositiveInt(`mesh-visible-palette:${seed}`));

    for (let index = visible.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [visible[index], visible[swapIndex]] = [visible[swapIndex], visible[index]];
    }

    const firstSaturatedIndex = visible.findIndex(isSaturatedAnchorPaletteRole);
    if (firstSaturatedIndex > 0) {
        [visible[0], visible[firstSaturatedIndex]] = [visible[firstSaturatedIndex], visible[0]];
    }

    return [...visible, ...remaining];
}

function shuffleAnchors(random: () => number): Array<readonly [number, number]> {
    const anchors = [...COLOR_FIELD_ANCHORS];
    for (let index = anchors.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [anchors[index], anchors[swapIndex]] = [anchors[swapIndex], anchors[index]];
    }
    return anchors;
}

function buildPhotoGradientPaletteRoles(
    theme: MeshGradientThemeInput,
    isDarkTheme: boolean,
): Record<PhotoGradientPaletteRole, string> {
    const blue = getAccentColor(theme, 0, 0);
    const green = getAccentColor(theme, 1, 0);
    const orange = getAccentColor(theme, 2, 1);
    const yellow = getAccentColor(theme, 3, 2);
    const red = getAccentColor(theme, 4, 2);
    const indigo = getAccentColor(theme, 5, 0);
    const purple = getAccentColor(theme, 6, 5);
    const liftedNeutral = isDarkTheme
        ? mixColor(theme.surfaceHigh, theme.textSecondary, DARK_LIFTED_NEUTRAL_MIX)
        : darkenColor(theme.surfaceHigh, LIGHT_LIFTED_NEUTRAL_DARKEN);
    const groundedNeutral = isDarkTheme
        ? mixColor(theme.surfaceHighest, theme.textSecondary, DARK_GROUNDED_NEUTRAL_MIX)
        : darkenColor(theme.surfaceHighest, LIGHT_GROUNDED_NEUTRAL_DARKEN);
    const darkToneBoost = isDarkTheme ? DARK_ACCENT_NEUTRAL_BOOST : 0;
    const tealBase = mixColor(blue, green, 0.46);
    const goldBase = mixColor(yellow, orange, 0.42);
    const forestBase = mixColor(green, theme.textSecondary, 0.48);
    const clayBase = mixColor(orange, red, 0.42);
    const sageBase = mixColor(green, blue, 0.36);
    const slateBase = mixColor(blue, theme.textSecondary, 0.46);
    const roseBase = mixColor(red, purple, 0.3);
    const lavenderBase = mixColor(indigo, purple, 0.45);

    return {
        teal: mixColor(tealBase, liftedNeutral, isDarkTheme ? 0.3 + darkToneBoost : 0.14),
        gold: mixColor(goldBase, groundedNeutral, isDarkTheme ? 0.38 + darkToneBoost : 0.26),
        forest: mixColor(forestBase, liftedNeutral, isDarkTheme ? 0.3 + darkToneBoost : 0.24),
        clay: mixColor(clayBase, groundedNeutral, isDarkTheme ? 0.34 + darkToneBoost : 0.2),
        sage: mixColor(sageBase, liftedNeutral, isDarkTheme ? 0.46 + darkToneBoost : 0.48),
        cream: mixColor(groundedNeutral, goldBase, isDarkTheme ? 0.32 : 0.28),
        sand: mixColor(groundedNeutral, goldBase, isDarkTheme ? 0.38 : 0.32),
        slate: mixColor(slateBase, liftedNeutral, isDarkTheme ? 0.44 + darkToneBoost : 0.28),
        rose: mixColor(roseBase, liftedNeutral, isDarkTheme ? 0.46 + darkToneBoost : 0.32),
        lavender: mixColor(lavenderBase, liftedNeutral, isDarkTheme ? 0.48 + darkToneBoost : 0.34),
        sky: mixColor(blue, liftedNeutral, isDarkTheme ? 0.44 + darkToneBoost : 0.26),
        coral: mixColor(mixColor(red, orange, 0.38), groundedNeutral, isDarkTheme ? 0.38 + darkToneBoost : 0.22),
        olive: mixColor(mixColor(green, yellow, 0.32), groundedNeutral, isDarkTheme ? 0.42 + darkToneBoost : 0.28),
    };
}

function buildPalette(theme: MeshGradientThemeInput, random: () => number, monochrome: boolean, seed: number): string[] {
    const isDarkTheme = isDarkThemeInput(theme);
    const roles = buildPhotoGradientPaletteRoles(theme, isDarkTheme);
    const family = pickSeeded(PHOTO_GRADIENT_PALETTE_ROLE_FAMILIES, random);
    const orderedRoles = orderPaletteRoles(family, random);
    const palette = uniqueColors(varyStructuredVisiblePaletteRoles(orderedRoles, seed).map((role) => roles[role]));
    return monochrome ? palette.map(toNeutralColor) : palette;
}

function createColorField(
    color: string,
    random: () => number,
    size: number,
    index: number,
    anchors: readonly (readonly [number, number])[],
): MeshGradientColorField {
    const anchor = anchors[index % anchors.length];
    const normalizedX = anchor[0] + ((random() - 0.5) * COLOR_FIELD_JITTER);
    const normalizedY = anchor[1] + ((random() - 0.5) * COLOR_FIELD_JITTER);

    return {
        cx: normalizedX * size,
        cy: normalizedY * size,
        radius: (COLOR_FIELD_RADIUS_MIN + (random() * COLOR_FIELD_RADIUS_VARIANCE)) * size,
        color,
        transparentColor: withAlpha(color, 0),
        opacity: COLOR_FIELD_OPACITY_MIN + (random() * COLOR_FIELD_OPACITY_VARIANCE),
    };
}

function createWaveField(
    color: string,
    random: () => number,
    size: number,
): MeshGradientWaveField {
    return {
        x: ((random() * 1.2) - 0.1) * size,
        y: ((random() * 1.2) - 0.1) * size,
        width: (0.75 + (random() * 0.65)) * size,
        height: (0.18 + (random() * 0.18)) * size,
        rotation: (random() * 70) - 35,
        color,
        transparentColor: withAlpha(color, 0),
        opacity: 0.18 + (random() * 0.12),
    };
}

export function deriveMeshGradientAvatar(params: DeriveMeshGradientAvatarParams): MeshGradientAvatarModel {
    const seed = hashStringToPositiveInt(params.id);
    const random = createSeededRandom(seed);
    const palette = buildPalette(params.theme, random, params.monochrome, seed);
    const startColor = pickSeeded(palette, random);
    const endColor = pickSeeded(palette, random);
    const depthSourceColor = pickSeeded(palette, random);
    const highlightSourceColor = mixColor(params.theme.surface, pickSeeded(palette, random), 0.12);
    const fieldCount = COLOR_FIELD_MIN_COUNT + (seed % COLOR_FIELD_COUNT_VARIANCE);
    const anchors = shuffleAnchors(random);

    return {
        patternVariant: params.patternVariant ?? pickMeshGradientPatternVariant(seed),
        baseGradient: {
            startX: random() * params.size,
            startY: random() * params.size,
            endX: random() * params.size,
            endY: random() * params.size,
            startColor,
            endColor,
        },
        depthField: createDepthField(depthSourceColor, random, params.size),
        highlightField: createHighlightField(highlightSourceColor, random, params.size),
        colorFields: Array.from({ length: fieldCount }, (_, index) =>
            createColorField(palette[index % palette.length], random, params.size, index, anchors),
        ),
        waveFields: Array.from({ length: WAVE_FIELD_COUNT }, (_, index) =>
            createWaveField(palette[(index + fieldCount) % palette.length], random, params.size),
        ),
    };
}
