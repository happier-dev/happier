import * as React from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';
import type { SessionNavigationDirection } from '@/sync/domains/session/navigation/sessionNavigationOrder';

export type SystemTabBarSessionNavigationEvent = Readonly<{ direction: SessionNavigationDirection }> & (
    | Readonly<{ source: 'accessibility' }>
    | Readonly<{ source: 'swipe'; translationX: number; translationY: number; velocityX: number; maxAbsTranslationX: number }>
);

type SessionNavigation = Readonly<{
    swipeEnabled: boolean;
    labels: Readonly<Record<SessionNavigationDirection, string>> | null;
    onNavigate: (event: SystemTabBarSessionNavigationEvent) => void;
}>;

export type SystemTabItem = Readonly<{
    id: string;
    title: string;
    sfSymbol: string;
    badge?: string;
    accessibilityLabel?: string;
    action?: boolean;
    disabled?: boolean;
}>;

type NativeProps = ViewProps & Readonly<{
    items: readonly SystemTabItem[];
    selectedId: string;
    hidden: boolean;
    showLabels: boolean;
    tintColor: string;
    onTabPress: (event: { nativeEvent: { id: string } }) => void;
    sessionSwipeEnabled: boolean;
    sessionNavigationLabels: SessionNavigation['labels'];
    onSessionNavigate: (event: { nativeEvent: SystemTabBarSessionNavigationEvent }) => void;
}>;

const nativeModule = Platform.OS === 'ios'
    ? requireOptionalNativeModule<{ isSupported?: boolean }>('HappierSystemTabBar') : null;
export const systemTabBarAvailable = nativeModule?.isSupported === true;
const NativeBar = systemTabBarAvailable ? requireNativeViewManager<NativeProps>('HappierSystemTabBar') : null;

export function SystemTabBar({ onPress, sessionNavigation, ...props }: Omit<NativeProps, 'onTabPress' | 'sessionSwipeEnabled' | 'sessionNavigationLabels' | 'onSessionNavigate'> & Readonly<{
    onPress: (id: string) => void;
    sessionNavigation?: SessionNavigation;
}>) {
    const onTabPress = React.useCallback(({ nativeEvent }: { nativeEvent: { id: string } }) => onPress(nativeEvent.id), [onPress]);
    const onSessionNavigate = React.useCallback(({ nativeEvent }: { nativeEvent: SystemTabBarSessionNavigationEvent }) => {
        sessionNavigation?.onNavigate(nativeEvent);
    }, [sessionNavigation]);
    return NativeBar ? <NativeBar {...props} onTabPress={onTabPress}
        sessionSwipeEnabled={sessionNavigation?.swipeEnabled ?? false}
        sessionNavigationLabels={sessionNavigation?.labels ?? null} onSessionNavigate={onSessionNavigate}
        style={{ width: 0, height: 0 }} accessible={false} /> : null;
}
