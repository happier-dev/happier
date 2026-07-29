import * as React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';

/**
 * Opens the session details page.
 *
 * This used to be the avatar's job. An avatar is an identity — it says which session you are in —
 * and nothing about it suggests it is also a link, so the details page was effectively hidden
 * behind a control nobody would think to press. The avatar keeps the identity role in the header's
 * leading slot, and the navigation it was carrying moves here, where it looks like what it is.
 */
export const SessionHeaderInfoButton = React.memo((props: Readonly<{
    onPress: () => void;
}>) => {
    const { theme } = useUnistyles();
    const testId = useOptionalSessionScreenTestId('session-header-info-button');

    return (
        <Pressable
            testID={testId}
            onPress={props.onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('sessionInfo.title')}
        >
            <Ionicons
                name="information-circle-outline"
                size={SESSION_HEADER_ICON_SIZE_PX}
                color={theme.colors.chrome.header.foreground}
            />
        </Pressable>
    );
});

SessionHeaderInfoButton.displayName = 'SessionHeaderInfoButton';
