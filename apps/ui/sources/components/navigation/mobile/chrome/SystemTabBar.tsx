import * as React from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export type SystemTabItem = Readonly<{
    id: string;
    title: string;
    sfSymbol: string;
    badge?: string;
    accessibilityLabel?: string;
    action?: boolean;
}>;

type NativeProps = ViewProps & Readonly<{
    items: readonly SystemTabItem[];
    selectedId: string;
    hidden: boolean;
    tintColor: string;
    onTabPress: (event: { nativeEvent: { id: string } }) => void;
}>;

export const systemTabBarAvailable = Platform.OS === 'ios' && !!requireOptionalNativeModule('HappierSystemTabBar');
const NativeBar = systemTabBarAvailable ? requireNativeViewManager<NativeProps>('HappierSystemTabBar') : null;

export function SystemTabBar({ onPress, ...props }: Omit<NativeProps, 'onTabPress'> & Readonly<{ onPress: (id: string) => void }>) {
    const onTabPress = React.useCallback(({ nativeEvent }: { nativeEvent: { id: string } }) => {
        onPress(nativeEvent.id);
    }, [onPress]);
    return NativeBar ? <NativeBar {...props} onTabPress={onTabPress} style={{ width: 0, height: 0 }} accessible={false} /> : null;
}
