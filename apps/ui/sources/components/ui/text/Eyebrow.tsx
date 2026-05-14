import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

import { Text, type AppTextProps } from './Text';

export type EyebrowProps = AppTextProps;

function resolveEyebrowTypography() {
    const helpers = Typography as Readonly<{
        eyebrow?: () => object;
        default?: (weight?: 'regular' | 'italic' | 'semiBold') => object;
    }>;
    return typeof helpers.eyebrow === 'function'
        ? helpers.eyebrow()
        : (helpers.default?.('semiBold') ?? {});
}

const stylesheet = StyleSheet.create((theme) => ({
    text: {
        ...resolveEyebrowTypography(),
        color: theme.colors.text.secondary,
    },
}));

export function Eyebrow({ style, ...props }: EyebrowProps): React.ReactElement {
    const styles = stylesheet;
    return (
        <Text
            {...props}
            style={[styles.text, style]}
        />
    );
}
