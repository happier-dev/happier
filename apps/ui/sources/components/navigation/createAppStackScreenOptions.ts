import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { Platform } from 'react-native';

import { Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';

import { useAppShellColumn } from '@/components/navigation/shell/appRail/appShellColumnContext';
import { isRunningOnMac } from '@/utils/platform/platform';

import { createHeader } from './Header';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

/**
 * Whether stacks draw the app's own header (`createHeader`) rather than the native one: Android, Mac
 * Catalyst and the web, and everywhere inside the desktop app shell, whose one header rule (pages
 * there draw no stack header) lives in `createHeader`. iPhone keeps the native header.
 */
export function useAppStackUsesCustomHeader(): boolean {
    const shell = useAppShellColumn();
    return Platform.OS === 'android' || isRunningOnMac() || Platform.OS === 'web' || shell.present;
}

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
            backgroundColor: glassSurfaceBackgroundColor(args.theme.colors.surface.base, 'content', true),
        },
        headerStyle: {
            backgroundColor: args.shouldUseCustomHeader ? args.theme.colors.chrome.header.background
                : glassSurfaceBackgroundColor(args.theme.colors.surface.base, 'content', true),
        },
        headerTintColor: args.theme.colors.chrome.header.foreground,
        headerTitleStyle: {
            color: args.theme.colors.chrome.header.foreground,
            ...Typography.default('semiBold'),
        },
    };
}
