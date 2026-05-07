import * as React from 'react';
import { Pressable, type ImageStyle, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';

const SIDEBAR_LOGO_IMAGE_STYLE: ImageStyle = {
    height: 24,
    width: 24,
};

type SidebarLogoButtonProps = Readonly<{
    onPress: () => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

export const SidebarLogoButton = React.memo((props: SidebarLogoButtonProps) => {
    const { theme } = useUnistyles();

    return (
        <Pressable
            testID={props.testID}
            onPress={props.onPress}
            hitSlop={15}
            accessibilityRole="button"
            accessibilityLabel={t('common.home')}
            style={props.style}
        >
            <Image
                source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                contentFit="contain"
                style={[SIDEBAR_LOGO_IMAGE_STYLE]}
            />
        </Pressable>
    );
});
