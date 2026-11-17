import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';
import type { EnrichedMarkdownTextProps, MarkdownStyle } from 'react-native-enriched-markdown';
import { useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics, resolveHappierTypeScale } from '@happier-dev/plugin-ui/presentation';

import { Typography } from '@/constants/Typography';
import { resolveTranscriptPaint } from '@/components/sessions/transcript/transcriptPaint';
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
    uiFontScale: number;
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

type UnistylesContext = ReturnType<typeof useUnistyles>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function flattenTextStyle(style: unknown, context?: UnistylesContext): TextStyle {
    if (!style) {
        return {};
    }

    if (Array.isArray(style)) {
        return style.reduce<TextStyle>((flattened, entry) => ({
            ...flattened,
            ...flattenTextStyle(entry, context),
        }), {});
    }

    if (typeof style !== 'object') {
        return {};
    }

    // Unistyles 3.2 web entries retain stylesheet/key/arguments behind their
    // CSS classes. Native entries expose the same values through uni__getStyles.
    // Resolve before spreading arrays or scaling, which would lose hidden metrics.
    let resolved: TextStyle = {};
    for (const key of Object.getOwnPropertyNames(style)) {
        if (!key.startsWith('unistyles_')) continue;
        const secret: unknown = Reflect.get(style, key);
        if (!isRecord(secret)) continue;
        if (typeof secret.uni__getStyles === 'function') {
            resolved = { ...resolved, ...flattenTextStyle(Reflect.apply(secret.uni__getStyles, secret, []), context) };
        } else if (context && typeof secret.__uni__key === 'string') {
            const stylesheet: unknown = typeof secret.__uni__stylesheet === 'function'
                ? Reflect.apply(secret.__uni__stylesheet, undefined, [context.theme, context.rt])
                : secret.__uni__stylesheet;
            const entry: unknown = isRecord(stylesheet) ? stylesheet[secret.__uni__key] : undefined;
            const values: unknown = typeof entry === 'function'
                ? Reflect.apply(entry, undefined, Array.isArray(secret.__uni__args) ? secret.__uni__args : [])
                : entry;
            resolved = { ...resolved, ...flattenTextStyle(values, context) };
        }
    }
    // Plain overrides retain React Native's last-entry-wins order. Non-enumerable
    // values on web entries are the creation-time projection; use the current one above.
    const plain = Object.fromEntries(Object.entries(style).filter(([key]) => !key.startsWith('unistyles_')));
    return { ...resolved, ...plain };
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
    const flattenedTextStyle = scaleTextStyle(flattenTextStyle(params.textStyle), uiFontScale);

    const widget = params.profile === 'widget';
    // A document or widget is Markdown placed inside interface chrome (a plugin's detail step, a board
    // widget). Its body reads at the interface's reading size and its headings step down from the type
    // roles, so no heading outranks the title of the step or card that holds it. Transcript Markdown keeps
    // its own larger domain scale.
    const embedded = widget || params.profile === 'document';
    const widgetText = happierPageTextMetrics('sectionDescription');
    const readingText = resolveHappierTypeScale('reading', Platform.OS);
    const embeddedBase = widget ? widgetText : params.profile === 'document' ? readingText : null;
    const baseFontSize = readNumber(flattenedTextStyle.fontSize, roundTo2((embeddedBase?.fontSize ?? 16) * uiFontScale));
    const baseLineHeight = readNumber(flattenedTextStyle.lineHeight, roundTo2((embeddedBase?.lineHeight ?? 24) * uiFontScale));
    const inlineCodeFontSize = roundTo2(baseFontSize * 0.88);
    const baseColor = resolveTranscriptPaint({ colors: params.colors }, 'user-bubble', 'text',
        typeof flattenedTextStyle.color === 'string' && flattenedTextStyle.color.length > 0 ? flattenedTextStyle.color : undefined).foreground.color;
    const roleMetric = (role: 'heading' | 'label' | 'reading') => {
        const step = resolveHappierTypeScale(role, Platform.OS);
        return { fontSize: roundTo2(step.fontSize * uiFontScale), lineHeight: roundTo2(step.lineHeight * uiFontScale) };
    };
    const h1FontSize = embedded ? Math.max(baseFontSize, roleMetric('heading').fontSize) : scaledMetric(baseFontSize, 1.5);
    const h2FontSize = embedded ? Math.max(baseFontSize, roleMetric('label').fontSize) : scaledMetric(baseFontSize, 1.25);
    const h3FontSize = embedded ? Math.max(baseFontSize, roleMetric('reading').fontSize) : scaledMetric(baseFontSize, 1.125);
    const h6FontSize = embedded ? baseFontSize : scaledMetric(baseFontSize, 0.875);
    const h1LineHeight = embedded ? Math.max(roleMetric('heading').lineHeight, h1FontSize) : Math.max(baseLineHeight, scaledMetric(h1FontSize, 1.3));
    const h2LineHeight = embedded ? Math.max(roleMetric('label').lineHeight, h2FontSize) : Math.max(baseLineHeight, scaledMetric(h2FontSize, 1.35));
    const h3LineHeight = embedded ? Math.max(baseLineHeight, roleMetric('reading').lineHeight) : Math.max(baseLineHeight, scaledMetric(h3FontSize, 1.4));
    const h6LineHeight = embedded ? baseLineHeight : Math.max(scaledMetric(baseLineHeight, 0.875), scaledMetric(h6FontSize, 1.4));
    // Embedded headings sit closer to their text: the ramp is one or two points, so space does the rest.
    const headingSpace = embedded
        ? { h1: [16, 6], h2: [16, 4], h3: [12, 4], h4: [10, 4], h5: [8, 4], h6: [8, 4] } as const
        : { h1: [18, 10], h2: [16, 8], h3: [14, 8], h4: [10, 6], h5: [8, 6], h6: [8, 6] } as const;
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
            marginTop: 0,
            marginBottom: 8,
        },
        h1: {
            ...headingBase,
            fontSize: h1FontSize,
            lineHeight: h1LineHeight,
            marginTop: headingSpace.h1[0],
            marginBottom: headingSpace.h1[1],
        },
        h2: {
            ...headingBase,
            fontSize: h2FontSize,
            lineHeight: h2LineHeight,
            marginTop: headingSpace.h2[0],
            marginBottom: headingSpace.h2[1],
        },
        h3: {
            ...headingBase,
            fontSize: h3FontSize,
            lineHeight: h3LineHeight,
            marginTop: headingSpace.h3[0],
            marginBottom: headingSpace.h3[1],
        },
        h4: {
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            marginTop: headingSpace.h4[0],
            marginBottom: headingSpace.h4[1],
        },
        h5: {
            ...headingBase,
            fontSize: baseFontSize,
            lineHeight: baseLineHeight,
            marginTop: headingSpace.h5[0],
            marginBottom: headingSpace.h5[1],
        },
        h6: {
            ...headingBase,
            fontSize: h6FontSize,
            lineHeight: h6LineHeight,
            marginTop: headingSpace.h6[0],
            marginBottom: headingSpace.h6[1],
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
            // An embedded list closes on the paragraph rhythm, so the next heading's space is the only gap.
            ...(embedded ? { marginBottom: 8 } : {}),
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
            textAlign: 'center' as const,
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
            checkedColor: widget ? params.colors.text.secondary : params.colors.text.link,
            borderColor: widget ? params.colors.text.secondary : params.colors.border.default,
            checkboxSize: roundTo2((widget ? 14 : 18) * uiFontScale),
            checkboxBorderRadius: 4,
            checkmarkColor: widget ? params.colors.surface.elevated : params.colors.text.primary,
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
        uiFontScale,
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
    const { theme, rt } = useUnistyles();
    const uiFontScale = useLocalSetting('uiFontScale') ?? 1;
    // Unistyles returns fresh proxies each render. Read through them to subscribe
    // to stylesheet dependencies, then memoize the bundle by the metrics it consumes.
    const { fontSize, lineHeight, color } = flattenTextStyle(params.textStyle, { theme, rt });

    return React.useMemo(() => buildEnrichedMarkdownStyle({
        colors: theme.colors,
        profile: params.profile,
        textStyle: { fontSize, lineHeight, color },
        uiFontScale,
    }), [params.profile, fontSize, lineHeight, color, theme.colors, uiFontScale]);
}
