import {
    HappierTextSelectabilityScope,
    useHappierTextPresentation,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import {
    Platform,
    Text as RNText,
    TextInput as RNTextInput,
    type TextInputProps as RNTextInputProps,
    type TextProps as RNTextProps,
    type TextStyle,
} from 'react-native';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';

import { scaleTextStyle } from './uiFontScale';

function isIosWeb(): boolean {
    if (Platform.OS !== 'web') return false;
    if (typeof navigator === 'undefined') return false;
    const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
    return /iphone|ipad|ipod/i.test(ua);
}

function resolveFontSizeFromStyle(style: unknown): number | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (let i = style.length - 1; i >= 0; i -= 1) {
            const resolved = resolveFontSizeFromStyle(style[i]);
            if (typeof resolved === 'number') {
                return resolved;
            }
        }
        return null;
    }
    if (typeof style === 'object') {
        const maybeStyle = style as { fontSize?: unknown };
        return typeof maybeStyle.fontSize === 'number' ? maybeStyle.fontSize : null;
    }
    return null;
}

/**
 * Selectability scoping is owned by the shared presentation layer, so a plugin
 * surface rendered inside a Happier scope inherits the same behaviour.
 */
export const TextSelectabilityScope = HappierTextSelectabilityScope;

export type AppTextProps = Omit<RNTextProps, 'style'> & Readonly<{
    /** App-owned hosts retain the complete React Native text style contract. */
    style?: RNTextProps['style'];
    /** Web focus-order override forwarded to the underlying React Native Web text element. */
    tabIndex?: 0 | -1;
    /**
     * Whether to use the default typography. Set to false to skip the default font.
     * Useful when you want to control typography via `style` (e.g. `Typography.mono()`).
     */
    useDefaultTypography?: boolean;
    /** Whether the text should be selectable. Defaults to false. */
    selectable?: boolean;
    /** Escape hatch for special surfaces (defaults to false). */
    disableUiFontScaling?: boolean;
}>;

/**
 * Happier core's Text adapter.
 *
 * The shared presentation owner supplies the text-scale and selectability
 * semantics. This adapter owns the native host because app callers require the
 * full React Native text prop/style contract (including Unistyles entries).
 */
export const Text = React.memo(
    React.forwardRef<any, AppTextProps>(function AppText(
        {
            style,
            useDefaultTypography = true,
            disableUiFontScaling = false,
            selectable,
            allowFontScaling,
            ...props
        },
        ref
    ) {
        const uiFontScaleSetting = useLocalSetting('uiFontScale');
        const uiFontScale = disableUiFontScaling ? 1 : uiFontScaleSetting;
        const baseStyle = useDefaultTypography ? Typography.default() : undefined;
        const presentation = useHappierTextPresentation({ selectable, textScale: uiFontScale });
        const scaledStyle = React.useMemo(
            () => scaleTextStyle(style, presentation.metricScale),
            [presentation.metricScale, style],
        );
        const mergedStyle = React.useMemo(() => {
            const entries: NonNullable<RNTextProps['style']>[] = [];
            if (baseStyle) entries.push(baseStyle);
            if (scaledStyle) entries.push(scaledStyle);
            return entries;
        }, [baseStyle, scaledStyle]);

        return (
            <RNText
                ref={ref}
                style={mergedStyle}
                selectable={presentation.selectable}
                {...props}
                allowFontScaling={allowFontScaling ?? presentation.allowHostFontScaling}
            />
        );
    })
);

export type AppTextInputProps = RNTextInputProps & Readonly<{
    useDefaultTypography?: boolean;
    disableUiFontScaling?: boolean;
}>;

export const TextInput = React.memo(
    React.forwardRef<any, AppTextInputProps>(function AppTextInput(
        { style, useDefaultTypography = true, disableUiFontScaling = false, ...props },
        ref
    ) {
        const uiFontScaleSetting = useLocalSetting('uiFontScale');
        const uiFontScale = disableUiFontScaling ? 1 : uiFontScaleSetting;
        const { accessibilityLabel, testID, ...restProps } = props;

        const scaledStyle = React.useMemo(() => scaleTextStyle(style, uiFontScale), [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mergedStyle = React.useMemo(() => {
            const out: NonNullable<RNTextInputProps['style']>[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (scaledStyle) out.push(scaledStyle);
            if (isIosWeb()) {
                const resolvedFontSize = resolveFontSizeFromStyle(out);
                if (typeof resolvedFontSize === 'number' && resolvedFontSize > 0 && resolvedFontSize < 16) {
                    out.push({ fontSize: 16 });
                }
            }
            return out;
        }, [defaultStyle, scaledStyle]);

        return (
            <RNTextInput
                ref={ref}
                style={mergedStyle}
                accessibilityLabel={accessibilityLabel}
                testID={testID}
                {...restProps}
            />
        );
    })
);
