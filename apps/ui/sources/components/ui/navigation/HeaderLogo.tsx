import * as React from 'react';
import { View } from 'react-native';
import { SafeExpoImage as Image } from '@/components/ui/media/SafeExpoImage';
import { useUnistyles } from 'react-native-unistyles';

/**
 * The Happier mark. Shared by the main-tab headers (extracted to prevent flickering on tab
 * switches - when each tab had its own HeaderLeft, the component would unmount/remount) and by
 * rows that name the Happier Cloud service. `size` is the mark's size; its box adds a small inset
 * (`inset`, 8 by default), which a page row drops so its own leading column sets the box.
 */
export const HeaderLogo = React.memo((props: Readonly<{ size?: number; inset?: number }>) => {
    const size = props.size ?? 24;
    const inset = props.inset ?? 8;
    const { rt } = useUnistyles();
    const source = rt.themeName === 'dark'
        ? require('@/assets/images/logo-white.png')
        : require('@/assets/images/logo-black.png');
    return (
        <View style={{
            width: size + inset,
            height: size + inset,
            alignItems: 'center',
            justifyContent: 'center',
        }}>
            <Image
                source={source}
                contentFit="contain"
                style={{ width: size, height: size }}
            />
        </View>
    );
});
