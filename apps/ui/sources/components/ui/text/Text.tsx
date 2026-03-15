import * as React from 'react';
import {
    Text as RNText,
    TextInput as RNTextInput,
    type TextInputProps as RNTextInputProps,
    type TextProps as RNTextProps,
    type TextStyle,
} from 'react-native';

import { Typography } from '@/constants/Typography';
import { useLocalSetting } from '@/sync/store/hooks';

import { scaleTextStyle } from './uiFontScale';

const TextSelectabilityContext = React.createContext<boolean>(false);

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
                {...props}
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

        const scaledStyle = React.useMemo(() => scaleTextStyle(style as any, uiFontScale) as TextStyle, [style, uiFontScale]);
        const defaultStyle = useDefaultTypography ? Typography.default() : null;
        const mergedStyle = React.useMemo(() => {
            const out: any[] = [];
            if (defaultStyle) out.push(defaultStyle);
            if (Array.isArray(scaledStyle)) out.push(...scaledStyle);
            else if (scaledStyle) out.push(scaledStyle);
            return out;
        }, [defaultStyle, scaledStyle]);

        return (
            <RNTextInput
                ref={ref}
                style={mergedStyle}
                {...props}
            />
        );
    })
);
