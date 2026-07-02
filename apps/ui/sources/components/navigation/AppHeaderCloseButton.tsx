import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

const HEADER_CLOSE_BUTTON_HIT_SLOP = { top: 12, bottom: 12, left: 12, right: 12 } as const;

type AppHeaderCloseButtonProps = Readonly<{
    onPress: () => void;
    testID: string;
}>;

export const AppHeaderCloseButton = React.memo(function AppHeaderCloseButton(props: AppHeaderCloseButtonProps): React.ReactElement {
    const { theme } = useUnistyles();

    return (
        <TouchableOpacity
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={HEADER_CLOSE_BUTTON_HIT_SLOP}
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel={t('common.cancel')}
        >
            <Ionicons name="close" size={22} color={theme.colors.chrome.header.foreground} />
        </TouchableOpacity>
    );
});

const styles = StyleSheet.create({
    button: {
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
});
