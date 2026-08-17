import * as React from 'react';
import { type StyleProp, type TextStyle } from 'react-native';
import type { EnrichedMarkdownTextProps, MarkdownStyle } from 'react-native-enriched-markdown';
import { useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import type { MarkdownRenderingProfile } from '../rendering/MarkdownRenderingProfile';

type ThemeColors = Readonly<{
    text: Readonly<{
        primary: string;
        secondary: string;
        link: string;
    }>;
    surface: Readonly<{
        inset: string;
        elevated: string;
        selected: string;
    }>;
    border: Readonly<{
        default: string;
    }>;
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

function readTextAlign(style: TextStyle): NonNullable<TextStyle['textAlign']> | undefined {
    const textAlign = style.textAlign;
    return textAlign === 'auto'
        || textAlign === 'left'
        || textAlign === 'right'
        || textAlign === 'center'
        || textAlign === 'justify'
        ? textAlign
        : undefined;
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

function scaledMetric(base: number, multiplier: number): number {
    return roundTo2(base * multiplier);
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
    const inlineCodeFontSize = roundTo2(baseFontSize * 0.88);
    const baseColor = readString(flattenedTextStyle.color, params.colors.text.primary);
    const textAlign = readTextAlign(flattenedTextStyle);
    const mathTextAlign = textAlign === 'left' || textAlign === 'right' || textAlign === 'center'
        ? textAlign
        : 'center';
    const h1FontSize = scaledMetric(baseFontSize, 1.5);
    const h2FontSize = scaledMetric(baseFontSize, 1.25);
    const h3FontSize = scaledMetric(baseFontSize, 1.125);
    const h6FontSize = scaledMetric(baseFontSize, 0.875);
    const h1LineHeight = Math.max(baseLineHeight, scaledMetric(h1FontSize, 1.3));
    const h2LineHeight = Math.max(baseLineHeight, scaledMetric(h2FontSize, 1.35));
    const h3LineHeight = Math.max(baseLineHeight, scaledMetric(h3FontSize, 1.4));
    const h6LineHeight = Math.max(scaledMetric(baseLineHeight, 0.875), scaledMetric(h6FontSize, 1.4));
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
        paragraph: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: baseColor,
            textAlign,
            marginTop: 0,
            marginBottom: 8,
        },
        h1: {
            ...headingBase,
            fontSize: h1FontSize,
            lineHeight: h1LineHeight,
            marginTop: 18,
            marginBottom: 10,
        },
        h2: {
            ...headingBase,
            fontSize: h2FontSize,
            lineHeight: h2LineHeight,
            marginTop: 16,
            marginBottom: 8,
        },
        h3: {
            ...headingBase,
            fontSize: h3FontSize,
            lineHeight: h3LineHeight,
            marginTop: 14,
            marginBottom: 8,
        },
        h4: {
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            marginTop: 10,
            marginBottom: 6,
        },
        h5: {
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            marginTop: 8,
            marginBottom: 6,
        },
        h6: {
            ...headingBase,
            fontSize: h6FontSize,
            lineHeight: h6LineHeight,
            marginTop: 8,
            marginBottom: 6,
        },
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
            color: params.colors.text.link,
            underline: true,
        },
        code: {
            fontFamily: monoTypography.fontFamily,
            fontSize: inlineCodeFontSize,
            color: baseColor,
            backgroundColor: params.profile === 'thinking' ? 'transparent' : params.colors.surface.selected,
            borderColor: 'transparent',
        },
        codeBlock: {
            fontFamily: monoTypography.fontFamily,
            fontSize: roundTo2(14 * uiFontScale),
            lineHeight: roundTo2(20 * uiFontScale),
            color: baseColor,
            backgroundColor: params.profile === 'thinking' ? 'transparent' : params.colors.surface.elevated,
            borderColor: params.colors.border.default,
            borderRadius: 8,
            borderWidth: params.profile === 'thinking' ? 0 : 1,
            padding: 12,
        },
        blockquote: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: params.colors.text.secondary,
            borderColor: params.colors.border.default,
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
        thematicBreak: {
            color: params.colors.border.default,
            height: 1,
            marginTop: 8,
            marginBottom: 8,
        },
        math: {
            fontSize: baseFontSize,
            color: baseColor,
            backgroundColor: 'transparent',
            padding: 0,
            textAlign: mathTextAlign,
            marginTop: 8,
            marginBottom: 8,
        },
        inlineMath: {
            color: baseColor,
        },
        table: {
            ...defaultFace,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            color: baseColor,
            headerFontFamily: readFontFamily(semiBoldTypography),
            headerBackgroundColor: params.colors.surface.inset,
            headerTextColor: baseColor,
            rowEvenBackgroundColor: 'transparent',
            rowOddBackgroundColor: 'transparent',
            borderColor: params.colors.border.default,
            borderWidth: 1,
            borderRadius: 8,
            cellPaddingHorizontal: 16,
            cellPaddingVertical: 10,
        },
        taskList: {
            checkedColor: params.colors.text.link,
            borderColor: params.colors.border.default,
            checkboxSize: roundTo2(18 * uiFontScale),
            checkboxBorderRadius: 4,
            checkmarkColor: params.colors.text.primary,
            checkedTextColor: params.colors.text.secondary,
            checkedStrikethrough: true,
        },
        strikethrough: {
            color: baseColor,
        },
        underline: {
            color: baseColor,
        },
        spoiler: {
            color: params.colors.surface.elevated,
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
