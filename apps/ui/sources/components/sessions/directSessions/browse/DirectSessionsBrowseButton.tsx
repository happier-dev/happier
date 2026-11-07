import * as React from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { PressableSurface } from '@/components/ui/interaction/PressableSurface';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { t } from '@/text';

const styles = StyleSheet.create(() => ({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/** Header icon that opens provider-session browsing; renders nothing while direct sessions are off. */
export const DirectSessionsBrowseButton = React.memo(function DirectSessionsBrowseButton(props: Readonly<{
    buttonSize: number;
    iconSize: number;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { directSessionsEnabled } = useSessionListStorageKind();
    const handlePress = React.useCallback(() => {
        router.push('/direct/browse');
    }, [router]);

    if (!directSessionsEnabled) return null;
    const accessibilityLabel = t('directSessions.browseOpenExisting');

    return (
        <PressableSurface
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            webTooltip={accessibilityLabel}
            focusRingRadius={props.buttonSize / 2}
            hitSlop={8}
            onPress={handlePress}
            style={[
                styles.button,
                {
                    width: props.buttonSize,
                    height: props.buttonSize,
                    borderRadius: props.buttonSize / 2,
                },
            ]}
        >
            <Icon
                name="folder-open"
                size={props.iconSize}
                color={theme.colors.chrome.header.foreground}
            />
        </PressableSurface>
    );
});
