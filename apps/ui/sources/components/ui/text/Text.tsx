import * as React from 'react';
import { Platform, Text as RNText, TextInput as RNTextInput, type TextInputProps as RNTextInputProps, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';

import { scaleTextStyle } from './uiFontScale';

const TextSelectabilityContext = React.createContext<boolean>(false);
const WEB_TEXT_INPUT_NO_OUTLINE_STYLE = {
    outline: 'none',
    outlineStyle: 'none',
    outlineWidth: 0,
    outlineColor: 'transparent',
    boxShadow: 'none',
} as unknown as TextStyle;

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

export function TextSelectabilityScope(props: Readonly<{ selectable: boolean; children: React.ReactNode }>) {
    return (
        <TextSelectabilityContext.Provider value={props.selectable}>
            {props.children}
        </TextSelectabilityContext.Provider>
    );
}

export type AppTextProps = RNTextProps & Readonly<{
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

export const Text = React.memo(
    React.forwardRef<any, AppTextProps>(function AppText(
        {
            style,
            useDefaultTypography = true,
            selectable,
            disableUiFontScaling = false,
            ...props
        },
        ref
    ) {
        const uiFontScaleSetting = useLocalSetting('uiFontScale');
        const uiFontScale = disableUiFontScaling ? 1 : uiFontScaleSetting;
        const selectableFromScope = React.useContext(TextSelectabilityContext);
        const effectiveSelectable = selectable ?? selectableFromScope;
        const { accessibilityLabel, testID, ...restProps } = props;

        const scaledStyle = React.useMemo(() => scaleTextStyle(style as any, uiFontScale), [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mergedStyle = React.useMemo(() => {
            const out: any[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (Array.isArray(scaledStyle)) out.push(...scaledStyle);
            else if (scaledStyle) out.push(scaledStyle);
            return out;
        }, [defaultStyle, scaledStyle]);

        return (
            <RNText
                ref={ref}
                style={mergedStyle}
                selectable={effectiveSelectable}
                accessibilityLabel={accessibilityLabel}
                testID={testID}
                {...restProps}
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

        const scaledStyle = React.useMemo(() => scaleTextStyle(style as any, uiFontScale) as TextStyle, [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mergedStyle = React.useMemo(() => {
            const out: any[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (Array.isArray(scaledStyle)) out.push(...scaledStyle);
            else if (scaledStyle) out.push(scaledStyle);
            if (Platform.OS === 'web') {
                out.push(WEB_TEXT_INPUT_NO_OUTLINE_STYLE);
            }
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
