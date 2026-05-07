import type { AvatarStyleId } from '@/sync/domains/settings/registry/account/avatarStyleSetting';

import { createSeededRandom, hashStringToPositiveInt, pickSeeded } from '../avatarHash';
import type { MeshGradientThemeInput } from '../meshGradient/meshGradientTypes';
import {
    getPhotoGradientStyleDefinition,
} from './photoGradientStyleRegistry';
import type {
    PhotoGradientAvatarModel,
    PhotoGradientRgbColor,
} from './photoGradientTypes';

type Params = Readonly<{
    id: string;
    size: number;
    monochrome: boolean;
    styleId?: AvatarStyleId;
    theme: MeshGradientThemeInput;
}>;

const POINT_ANCHORS = [
    [0.16, 0.16],
    [0.5, 0.16],
    [0.84, 0.16],
    [0.16, 0.52],
    [0.52, 0.52],
    [0.84, 0.52],
    [0.16, 0.84],
] as const;
const CONTROL_POINT_JITTER = 0.09;
const PHOTO_GRADIENT_PALETTES = [
    ['#2483A5', '#E0B94B', '#477459', '#C45408', '#6E9091', '#EFE3D1', '#E4D5B9'],
    ['#92B3C9', '#C6D1D1', '#7B8E54', '#F66E56', '#F96656', '#F3F4EC'],
    ['#C6A94A', '#9AAA73', '#D5B986', '#6E9091', '#E3D2B2', '#A67852', '#EFE3D1'],
    ['#C89061', '#D7B35C', '#98A878', '#7EA28D', '#D9C5A5', '#B18C74', '#F0E4CE'],
    ['#B99C55', '#C9B877', '#8D9D75', '#DAB783', '#6F9B94', '#C58769', '#EADBC1'],
    ['#C7755C', '#D8A65A', '#A7B77A', '#86A995', '#C7B09C', '#E6CC9C', '#F2E4D0'],
] as const;
const MAX_BLUE_DOMINANCE = 48;

function clampChannel(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColor(color: string): PhotoGradientRgbColor | null {
    const match = color.match(/^#([0-9a-fA-F]{6})$/);
    if (!match) return null;
    return {
        r: Number.parseInt(match[1].slice(0, 2), 16),
        g: Number.parseInt(match[1].slice(2, 4), 16),
        b: Number.parseInt(match[1].slice(4, 6), 16),
    };
}

function parseRgbColor(color: string): PhotoGradientRgbColor | null {
    const match = color.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return {
        r: clampChannel(Number(match[1])),
        g: clampChannel(Number(match[2])),
        b: clampChannel(Number(match[3])),
    };
}

function parseColor(color: string): PhotoGradientRgbColor {
    return parseHexColor(color) ?? parseRgbColor(color) ?? { r: 120, g: 120, b: 120 };
}

function mixColor(
    from: PhotoGradientRgbColor,
    to: PhotoGradientRgbColor,
    amount: number,
): PhotoGradientRgbColor {
    const ratio = Math.max(0, Math.min(1, amount));
    return {
        r: clampChannel(from.r + ((to.r - from.r) * ratio)),
        g: clampChannel(from.g + ((to.g - from.g) * ratio)),
        b: clampChannel(from.b + ((to.b - from.b) * ratio)),
    };
}

function toNeutralColor(color: PhotoGradientRgbColor): PhotoGradientRgbColor {
    const value = clampChannel((color.r * 0.299) + (color.g * 0.587) + (color.b * 0.114));
    return { r: value, g: value, b: value };
}

function keepWarmBalanced(color: PhotoGradientRgbColor): PhotoGradientRgbColor {
    const warmChannel = Math.max(color.r, color.g);
    return {
        ...color,
        b: Math.min(color.b, warmChannel + MAX_BLUE_DOMINANCE),
    };
}

function buildPalette(theme: MeshGradientThemeInput, random: () => number, monochrome: boolean): PhotoGradientRgbColor[] {
    const photoPalette = pickSeeded(PHOTO_GRADIENT_PALETTES, random).map(parseColor);
    const surface = parseColor(theme.surface);
    const themeAccents = theme.accentColors.map(parseColor);
    const mixed = photoPalette.map((color, index) => {
        const accent = themeAccents[index % themeAccents.length] ?? color;
        return keepWarmBalanced(mixColor(mixColor(color, accent, 0.1), surface, 0.08));
    });
    return monochrome ? mixed.map(toNeutralColor) : mixed;
}

function shuffleAnchors(random: () => number): Array<readonly [number, number]> {
    const anchors = [...POINT_ANCHORS];
    for (let index = anchors.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [anchors[index], anchors[swapIndex]] = [anchors[swapIndex], anchors[index]];
    }
    return anchors;
}

export function derivePhotoGradientAvatar(params: Params): PhotoGradientAvatarModel {
    const style = getPhotoGradientStyleDefinition(params.styleId);
    const seed = hashStringToPositiveInt(`${params.id}:${style.id}`);
    const random = createSeededRandom(seed);
    const palette = buildPalette(params.theme, random, params.monochrome);
    const anchors = shuffleAnchors(random);
    const points = anchors.map((anchor, index) => ({
        x: (anchor[0] + ((random() - 0.5) * CONTROL_POINT_JITTER)) * params.size,
        y: (anchor[1] + ((random() - 0.5) * CONTROL_POINT_JITTER)) * params.size,
        color: palette[index % palette.length] ?? palette[0] ?? { r: 120, g: 120, b: 120 },
    }));

    return {
        id: params.id,
        styleId: style.id,
        renderMode: style.renderMode,
        warpVariant: style.warpVariant === 'auto'
            ? pickSeeded(['rows', 'columns', 'diagonal', 'waves', 'oval', 'valueNoise', 'voronoi'] as const, random)
            : style.warpVariant,
        size: params.size,
        seed,
        backgroundColor: mixColor(
            parseColor(params.theme.surface),
            palette[palette.length - 1] ?? { r: 238, g: 232, b: 218 },
            0.16,
        ),
        points,
        noiseRatio: 0.08 + (random() * 0.06),
        warpRatio: 0.18 + (random() * 0.22),
        warpSize: 1.25 + (random() * 1.5),
    };
}
