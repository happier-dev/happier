import * as React from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import type { EnrichedMarkdownTextProps, MarkdownStyle } from 'react-native-enriched-markdown';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import type { MarkdownRenderingProfile } from '../rendering/MarkdownRenderingProfile';

type ThemeColors = Readonly<{
    text: string;
    textSecondary: string;
    textLink: string;
    surfaceHigh: string;
    surfaceHighest: string;
    divider: string;
}>;

export type EnrichedMarkdownStyleBundle = Readonly<{
    markdownStyle: MarkdownStyle;
    containerStyle: NonNullable<EnrichedMarkdownTextProps['containerStyle']>;
}>;

function roundTo2(value: number): number {
    return Math.round(value * 100) / 100;
}

function readString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readFontFamily(style: TextStyle): string | undefined {
    return typeof style.fontFamily === 'string' ? style.fontFamily : undefined;
}

function readFontWeight(style: TextStyle): string | undefined {
    if (typeof style.fontWeight === 'string') return style.fontWeight;
    if (typeof style.fontWeight === 'number') return String(style.fontWeight);
    return undefined;
}

function readFontStyle(style: TextStyle): 'normal' | 'italic' | undefined {
    return style.fontStyle === 'normal' || style.fontStyle === 'italic' ? style.fontStyle : undefined;
}

function flattenTextStyle(style: unknown): TextStyle {
    if (!style) {
        return {};
    }

    if (Array.isArray(style)) {
        return style.reduce<TextStyle>((flattened, entry) => ({
            ...flattened,
            ...flattenTextStyle(entry),
        }), {});
    }

    if (typeof style !== 'object') {
        return {};
    }

    return style;
}

function blockFontFace(style: TextStyle): { fontFamily?: string; fontWeight?: string } {
    return {
        fontFamily: readFontFamily(style),
        fontWeight: readFontWeight(style),
    };
}

function withBlockMargins<T extends Record<string, unknown>>(
    style: T,
    defaults: Readonly<{ marginTop?: number; marginBottom?: number }>,
    overrides: Readonly<{ marginTop?: number; marginBottom?: number }>,
): T & Readonly<{ marginTop?: number; marginBottom?: number }> {
    return {
        ...style,
        ...(typeof (overrides.marginTop ?? defaults.marginTop) === 'number'
            ? { marginTop: overrides.marginTop ?? defaults.marginTop }
            : {}),
        ...(typeof (overrides.marginBottom ?? defaults.marginBottom) === 'number'
            ? { marginBottom: overrides.marginBottom ?? defaults.marginBottom }
            : {}),
    };
}

export function buildEnrichedMarkdownStyle(params: Readonly<{
    colors: ThemeColors;
    profile: MarkdownRenderingProfile;
    uiFontScale: number;
    textStyle?: StyleProp<TextStyle>;
}>): EnrichedMarkdownStyleBundle {
    const uiFontScale = typeof params.uiFontScale === 'number' && Number.isFinite(params.uiFontScale)
        ? params.uiFontScale
        : 1;
    const scaledTextStyle = scaleTextStyle(params.textStyle, uiFontScale);
    const flattenedTextStyle = flattenTextStyle(scaledTextStyle);

    const baseFontSize = readNumber(flattenedTextStyle.fontSize, roundTo2(16 * uiFontScale));
    const baseLineHeight = readNumber(flattenedTextStyle.lineHeight, roundTo2(24 * uiFontScale));
    const inlineCodeFontSize = roundTo2(baseFontSize * 0.92);
    const baseColor = readString(flattenedTextStyle.color, params.colors.text);
    const marginOverrides = {
        marginTop: typeof flattenedTextStyle.marginTop === 'number' ? flattenedTextStyle.marginTop : undefined,
        marginBottom: typeof flattenedTextStyle.marginBottom === 'number' ? flattenedTextStyle.marginBottom : undefined,
    };
    const defaultTypography = Typography.default();
    const semiBoldTypography = Typography.default('semiBold');
    const italicTypography = Typography.default('italic');
    const monoTypography = Typography.mono();
    const defaultFace = blockFontFace(defaultTypography);
    const semiBoldFace = blockFontFace(semiBoldTypography);

    const headingBase = {
        ...semiBoldFace,
        color: baseColor,
    };

    const markdownStyle: MarkdownStyle = {
        paragraph: withBlockMargins({
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: baseColor,
        }, { marginTop: 0, marginBottom: 8 }, marginOverrides),
        h1: withBlockMargins({
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
        }, { marginTop: 16, marginBottom: 8 }, marginOverrides),
        h2: withBlockMargins({
            ...headingBase,
            fontSize: readNumber(flattenedTextStyle.fontSize, roundTo2(20 * uiFontScale)),
            lineHeight: baseLineHeight,
        }, { marginTop: 16, marginBottom: 8 }, marginOverrides),
        h3: withBlockMargins({
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: readNumber(flattenedTextStyle.lineHeight, roundTo2(28 * uiFontScale)),
        }, { marginTop: 16, marginBottom: 8 }, marginOverrides),
        h4: withBlockMargins({
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
        }, { marginTop: 8, marginBottom: 8 }, marginOverrides),
        h5: withBlockMargins({
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
        }, {}, marginOverrides),
        h6: withBlockMargins({
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
        }, {}, marginOverrides),
        strong: {
            fontFamily: readFontFamily(semiBoldTypography),
            fontWeight: readFontFamily(semiBoldTypography) ? 'normal' : 'bold',
            color: baseColor,
        },
        em: {
            fontFamily: readFontFamily(italicTypography),
            fontStyle: readFontFamily(italicTypography) ? 'normal' : readFontStyle(italicTypography) ?? 'italic',
            color: baseColor,
        },
        link: {
            fontFamily: readFontFamily(defaultTypography),
            color: params.colors.textLink,
            underline: true,
        },
        code: {
            fontFamily: monoTypography.fontFamily,
            fontSize: inlineCodeFontSize,
            color: baseColor,
            backgroundColor: params.profile === 'thinking' ? 'transparent' : params.colors.surfaceHigh,
            borderColor: 'transparent',
        },
        codeBlock: {
            fontFamily: monoTypography.fontFamily,
            fontSize: roundTo2(14 * uiFontScale),
            lineHeight: roundTo2(20 * uiFontScale),
            color: baseColor,
            backgroundColor: params.profile === 'thinking' ? 'transparent' : params.colors.surfaceHighest,
            borderColor: params.colors.divider,
            borderRadius: 8,
            borderWidth: params.profile === 'thinking' ? 0 : 1,
            padding: 12,
        },
        blockquote: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: params.colors.textSecondary,
            borderColor: params.colors.divider,
            borderWidth: 2,
            gapWidth: 10,
            backgroundColor: 'transparent',
        },
        list: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: baseColor,
            markerColor: baseColor,
            bulletColor: baseColor,
            markerMinWidth: roundTo2(18 * uiFontScale),
            gapWidth: 8,
            marginLeft: roundTo2(28 * uiFontScale),
        },
        thematicBreak: withBlockMargins({
            color: params.colors.divider,
            height: 1,
        }, { marginTop: 8, marginBottom: 8 }, marginOverrides),
        math: withBlockMargins({
            fontSize: baseFontSize,
            color: baseColor,
            backgroundColor: 'transparent',
            padding: 0,
            textAlign: 'center' as const,
        }, { marginTop: 8, marginBottom: 8 }, marginOverrides),
        inlineMath: {
            color: baseColor,
        },
        table: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: baseColor,
            headerFontFamily: readFontFamily(semiBoldTypography),
            headerBackgroundColor: params.colors.surfaceHigh,
            headerTextColor: baseColor,
            rowEvenBackgroundColor: 'transparent',
            rowOddBackgroundColor: 'transparent',
            borderColor: params.colors.divider,
            borderWidth: 1,
            borderRadius: 8,
            cellPaddingHorizontal: 16,
            cellPaddingVertical: 10,
        },
        taskList: {
            checkedColor: params.colors.textLink,
            borderColor: params.colors.divider,
            checkboxSize: roundTo2(18 * uiFontScale),
            checkboxBorderRadius: 4,
            checkmarkColor: params.colors.text,
            checkedTextColor: params.colors.textSecondary,
            checkedStrikethrough: true,
        },
        strikethrough: {
            color: baseColor,
        },
        underline: {
            color: baseColor,
        },
        spoiler: {
            color: params.colors.surfaceHighest,
        },
    };

    return {
        markdownStyle,
        containerStyle: {
            width: '100%',
        },
    };
}

export function useEnrichedMarkdownStyle(params: Readonly<{
    profile: MarkdownRenderingProfile;
    textStyle?: StyleProp<TextStyle>;
}>): EnrichedMarkdownStyleBundle {
    const { theme } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale') ?? 1;

    return React.useMemo(() => buildEnrichedMarkdownStyle({
        colors: theme.colors,
        profile: params.profile,
        textStyle: params.textStyle,
        uiFontScale,
    }), [params.profile, params.textStyle, theme.colors, uiFontScale]);
}
