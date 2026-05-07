import { describe, expect, it } from 'vitest';

import { deriveMeshGradientAvatar } from './deriveMeshGradientAvatar';
import type { MeshGradientThemeInput } from './meshGradientTypes';

const themeInput = {
    surface: '#ffffff',
    surfaceHigh: '#f8f8f8',
    surfaceHighest: '#eeeeee',
    textSecondary: '#6c6c70',
    accentColors: ['#007aff', '#34c759', '#ff9500', '#ffcc00', '#ff3b30', '#5856d6'],
} satisfies MeshGradientThemeInput;

const darkThemeInput = {
    surface: '#18171c',
    surfaceHigh: '#2c2c2e',
    surfaceHighest: '#38383a',
    textSecondary: '#99999d',
    accentColors: ['#0a84ff', '#32d74b', '#ff9f0a', '#ffd60a', '#ff453a', '#5e5ce6', '#bf5af2'],
} satisfies MeshGradientThemeInput;

function readRgb(color: string): readonly [number, number, number] {
    const match = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    if (!match) throw new Error(`Unsupported rgb color: ${color}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function luminance(color: string): number {
    const [r, g, b] = readRgb(color);
    return (r * 0.299) + (g * 0.587) + (b * 0.114);
}

function chroma(color: string): number {
    const [r, g, b] = readRgb(color);
    return Math.max(r, g, b) - Math.min(r, g, b);
}

function hue(color: string): number {
    const [red, green, blue] = readRgb(color).map((channel) => channel / 255);
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    if (delta === 0) return 0;

    const hueValue = max === red
        ? ((green - blue) / delta) % 6
        : max === green
            ? ((blue - red) / delta) + 2
            : ((red - green) / delta) + 4;
    const degrees = hueValue * 60;
    return degrees < 0 ? degrees + 360 : degrees;
}

function colorFamily(color: string): string {
    if (chroma(color) < 42) return 'neutral';
    const degrees = hue(color);
    if (degrees >= 45 && degrees <= 160) return 'greenYellow';
    if (degrees >= 170 && degrees <= 250) return 'blueTeal';
    if (degrees >= 260 && degrees <= 330) return 'violet';
    if (degrees < 45 || degrees > 330) return 'redOrange';
    return 'other';
}

function isCoolAnchorColor(color: string): boolean {
    const degrees = hue(color);
    return chroma(color) >= 70 && degrees >= 170 && degrees <= 330;
}

function isWarmAnchorColor(color: string): boolean {
    const degrees = hue(color);
    return chroma(color) >= 70 && (degrees <= 75 || degrees >= 330);
}

function isColdBlueDominantColor(color: string): boolean {
    const degrees = hue(color);
    return chroma(color) >= 70 && degrees >= 190 && degrees <= 265;
}

function isRedDominantColor(color: string): boolean {
    const degrees = hue(color);
    return chroma(color) >= 70 && (degrees <= 30 || degrees >= 340);
}

function isMutedSupportingColor(color: string): boolean {
    return chroma(color) < 70;
}

function readRgbaAlpha(color: string): number {
    const match = color.match(/^rgba\(\d+, \d+, \d+, (0(?:\.\d+)?|1(?:\.0+)?)\)$/);
    if (!match) throw new Error(`Unsupported rgba color: ${color}`);
    return Number(match[1]);
}

describe('deriveMeshGradientAvatar', () => {
    it('derives the same bounded model for the same session identity', () => {
        const first = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });
        const second = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });

        expect(second).toEqual(first);
        expect(first.colorFields.length).toBeGreaterThanOrEqual(8);
        expect(first.colorFields.length).toBeLessThanOrEqual(10);
        for (const field of first.colorFields) {
            expect(Number.isFinite(field.cx)).toBe(true);
            expect(Number.isFinite(field.cy)).toBe(true);
            expect(field.radius).toBeGreaterThan(0);
            expect(field.opacity).toBeGreaterThan(0);
            expect(field.opacity).toBeLessThanOrEqual(1);
        }
    });

    it('varies the mesh for different session identities', () => {
        const first = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });
        const second = deriveMeshGradientAvatar({
            id: 'session-2',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });

        expect(second.colorFields).not.toEqual(first.colorFields);
    });

    it('assigns deterministic pattern variants across session identities', () => {
        const sampleIds = Array.from({ length: 24 }, (_, index) => `session-pattern-${index}`);
        const variants = new Set(sampleIds.map((id) => deriveMeshGradientAvatar({
            id,
            size: 48,
            monochrome: false,
            theme: themeInput,
        }).patternVariant));
        const repeated = deriveMeshGradientAvatar({
            id: 'session-pattern-7',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });

        expect(repeated.patternVariant).toBe(deriveMeshGradientAvatar({
            id: 'session-pattern-7',
            size: 48,
            monochrome: false,
            theme: themeInput,
        }).patternVariant);
        expect(variants).toEqual(new Set(['organic', 'columns', 'rows', 'diagonal', 'oval', 'waves', 'softNoise']));
    });

    it('honors an explicit pattern variant when a user selects one', () => {
        const deriveWithVariant = deriveMeshGradientAvatar as (
            params: Parameters<typeof deriveMeshGradientAvatar>[0] & { patternVariant: 'rows' }
        ) => ReturnType<typeof deriveMeshGradientAvatar>;

        const model = deriveWithVariant({
            id: 'session-explicit-pattern',
            size: 48,
            monochrome: false,
            theme: themeInput,
            patternVariant: 'rows',
        });

        expect(model.patternVariant).toBe('rows');
    });

    it('uses neutral colors when monochrome is requested', () => {
        const model = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: true,
            theme: themeInput,
        });

        for (const color of [model.baseGradient.startColor, model.baseGradient.endColor, ...model.colorFields.map((field) => field.color)]) {
            expect(color).toMatch(/^rgb\((\d+), \1, \1\)$/);
        }
    });

    it('tones theme accent colors before using them in the generated mesh', () => {
        const model = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });
        const rawAccentColors = new Set(themeInput.accentColors);

        for (const color of model.colorFields.map((field) => field.color)) {
            expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
            expect(rawAccentColors.has(color)).toBe(false);
        }
    });

    it('keeps the non-monochrome palette saturated and deep enough to avoid washed-out avatars', () => {
        const model = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });
        const fieldColors = model.colorFields.map((field) => field.color);

        expect(Math.max(...fieldColors.map(luminance))).toBeLessThan(235);
        expect(fieldColors.filter((color) => luminance(color) < 200).length).toBeGreaterThanOrEqual(3);
        expect(Math.max(...fieldColors.map(chroma))).toBeGreaterThan(90);
    });

    it('keeps generated palettes colorful without raw accent-level saturation', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3'];
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const fieldColors = model.colorFields.map((field) => field.color);
            const averageLuminance = fieldColors.reduce((sum, color) => sum + luminance(color), 0) / fieldColors.length;

            expect(Math.max(...fieldColors.map(chroma))).toBeLessThan(190);
            expect(averageLuminance).toBeGreaterThan(140);
        }
    });

    it('keeps vivid anchor colors present in generated palettes', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3'];
        for (const id of sampleIds) {
            const lightModel = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const darkModel = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: darkThemeInput,
            });
            const lightFieldColors = lightModel.colorFields.map((field) => field.color);
            const darkFieldColors = darkModel.colorFields.map((field) => field.color);
            const lightAverageChroma = lightFieldColors.reduce((sum, color) => sum + chroma(color), 0) / lightFieldColors.length;
            const darkAverageChroma = darkFieldColors.reduce((sum, color) => sum + chroma(color), 0) / darkFieldColors.length;

            expect(lightAverageChroma).toBeGreaterThanOrEqual(120);
            expect(darkAverageChroma).toBeGreaterThanOrEqual(95);
        }
    });

    it('keeps several saturated warm anchors in the visible structured fields', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3', 'Greeting', 'Greeting:1', 'Greeting:2'];
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const visibleColors = model.colorFields.slice(0, 5).map((field) => field.color);

            expect(visibleColors.filter(isWarmAnchorColor).length).toBeGreaterThanOrEqual(2);
            expect(visibleColors.some(isCoolAnchorColor)).toBe(true);
            expect(visibleColors.filter(isMutedSupportingColor).length).toBeLessThanOrEqual(2);
        }
    });

    it('varies the first visible column family without losing warm saturation', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3', 'Greeting', 'Greeting:1', 'Greeting:2', 'Test M', 'Markdown', 'Trigger', 'Structure', 'Plan', 'leeroy', 'patio'];
        const firstFamilies = new Set<string>();
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const visibleColors = model.colorFields.slice(0, 5).map((field) => field.color);
            const warmFieldCount = visibleColors.filter(isWarmAnchorColor).length;
            const coolFieldCount = visibleColors.filter(isCoolAnchorColor).length;

            firstFamilies.add(colorFamily(visibleColors[0]));
            expect(warmFieldCount).toBeGreaterThanOrEqual(2);
            expect(coolFieldCount).toBeGreaterThanOrEqual(1);
        }
        expect(firstFamilies.size).toBeGreaterThanOrEqual(2);
    });

    it('avoids leading red-blue contrast pairs that feel less harmonious than the PhotoGradient references', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3', 'Greeting', 'Greeting:1', 'Greeting:2'];
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const leadingColors = model.colorFields.slice(0, 2).map((field) => field.color);

            expect(leadingColors.some(isColdBlueDominantColor) && leadingColors.some(isRedDominantColor)).toBe(false);
        }
    });

    it('uses multiple color families instead of green-yellow dominant palettes', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3'];
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const fieldColors = model.colorFields.map((field) => field.color);
            const families = new Set(fieldColors.map(colorFamily));
            const greenYellowFields = fieldColors.filter((color) => colorFamily(color) === 'greenYellow');

            expect(families.size).toBeGreaterThanOrEqual(3);
            expect(greenYellowFields.length).toBeLessThanOrEqual(Math.ceil(fieldColors.length * 0.55));
        }
    });

    it('keeps dark theme palettes lifted and muted enough for dark surfaces', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3'];
        for (const id of sampleIds) {
            const model = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: darkThemeInput,
            });
            const fieldColors = model.colorFields.map((field) => field.color);
            const averageLuminance = fieldColors.reduce((sum, color) => sum + luminance(color), 0) / fieldColors.length;

            expect(Math.min(...fieldColors.map(luminance))).toBeGreaterThanOrEqual(125);
            expect(averageLuminance).toBeGreaterThanOrEqual(100);
            expect(Math.max(...fieldColors.map(chroma))).toBeLessThanOrEqual(160);
        }
    });

    it('keeps dark theme avatars internally luminous like the light theme avatars', () => {
        const sampleIds = ['session-1', 'session-2', 'session-3'];
        for (const id of sampleIds) {
            const lightModel = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: themeInput,
            });
            const darkModel = deriveMeshGradientAvatar({
                id,
                size: 48,
                monochrome: false,
                theme: darkThemeInput,
            });
            const lightAverageLuminance = lightModel.colorFields
                .map((field) => field.color)
                .reduce((sum, color) => sum + luminance(color), 0) / lightModel.colorFields.length;
            const darkAverageLuminance = darkModel.colorFields
                .map((field) => field.color)
                .reduce((sum, color) => sum + luminance(color), 0) / darkModel.colorFields.length;

            expect(darkAverageLuminance).toBeGreaterThanOrEqual(lightAverageLuminance - 25);
        }
    });

    it('derives deterministic depth and highlight fields for dimensional contrast', () => {
        const model = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });

        expect(model.depthField.color).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
        expect(model.depthField.transparentColor).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
        expect(model.depthField.radius).toBeGreaterThan(48 * 0.7);
        expect(model.highlightField.color).toMatch(/^rgba\(\d+, \d+, \d+, 0\.\d+\)$/);
        expect(model.highlightField.transparentColor).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
    });

    it('uses broad low-opacity fields so small avatars render as blended gradients', () => {
        const model = deriveMeshGradientAvatar({
            id: 'session-1',
            size: 48,
            monochrome: false,
            theme: themeInput,
        });

        expect(Math.min(...model.colorFields.map((field) => field.radius))).toBeGreaterThanOrEqual(48 * 0.66);
        expect(Math.min(...model.colorFields.map((field) => field.opacity))).toBeGreaterThanOrEqual(0.72);
        expect(Math.max(...model.colorFields.map((field) => field.opacity))).toBeLessThanOrEqual(0.86);
        expect(readRgbaAlpha(model.depthField.color)).toBeLessThanOrEqual(0.28);
        expect(model.depthField.radius).toBeGreaterThanOrEqual(48 * 0.9);
    });
});
