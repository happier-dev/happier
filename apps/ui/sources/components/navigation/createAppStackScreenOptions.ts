import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import { createHeader } from './Header';

export function createAppStackScreenOptions(args: Readonly<{
    headerBackTitle: string;
    shouldUseCustomHeader: boolean;
    theme: Theme;
}>): NativeStackNavigationOptions {
    return {
        header: args.shouldUseCustomHeader ? createHeader : undefined,
        headerBackTitle: args.headerBackTitle,
        headerShadowVisible: false,
        contentStyle: {
            backgroundColor: args.theme.colors.surface,
        },
        headerStyle: {
            backgroundColor: args.theme.colors.header.background,
        },
        headerTintColor: args.theme.colors.header.tint,
        headerTitleStyle: {
            color: args.theme.colors.header.tint,
            ...Typography.default('semiBold'),
        },
    };
}
