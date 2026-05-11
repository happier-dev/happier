import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';

import { createHeader } from './Header';

export function createAppStackScreenOptions(args: Readonly<{
    contentStyle?: NativeStackNavigationOptions['contentStyle'];
    headerBackTitle: string;
    shouldUseCustomHeader: boolean;
    theme: Theme;
}>): NativeStackNavigationOptions {
    return {
        header: args.shouldUseCustomHeader ? createHeader : undefined,
        headerBackTitle: args.headerBackTitle,
        headerShadowVisible: false,
        contentStyle: args.contentStyle ?? {
            backgroundColor: args.theme.colors.surface.base,
        },
        headerStyle: {
            backgroundColor: args.theme.colors.chrome.header.background,
        },
        headerTintColor: args.theme.colors.chrome.header.foreground,
        headerTitleStyle: {
            color: args.theme.colors.chrome.header.foreground,
            ...Typography.default('semiBold'),
        },
    };
}
