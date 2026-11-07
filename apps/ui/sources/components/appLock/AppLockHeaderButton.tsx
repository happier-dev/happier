import * as React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { lockAppLock, useAppLockSnapshot } from '@/auth/appLock/appLockRuntime';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * "Lock now" button for the header chrome, shown only while this device's app lock is on and
 * unlocked. It sits to the left of the Automations and New session buttons.
 */
export function AppLockHeaderButton(props: Readonly<{ style?: StyleProp<ViewStyle>; size?: number; testID?: string }>) {
    const { theme } = useUnistyles();
    const { status } = useAppLockSnapshot();
    if (status !== 'unlocked') return null;
    return (
        <Pressable
            testID={props.testID ?? 'header-app-lock'}
            onPress={() => lockAppLock()}
            hitSlop={15}
            style={props.style}
            accessibilityRole="button"
            accessibilityLabel={t('appLock.lockNowA11y')}
        >
            <Icon name="lock" size={props.size ?? 20} color={theme.colors.chrome.header.foreground} />
        </Pressable>
    );
}
