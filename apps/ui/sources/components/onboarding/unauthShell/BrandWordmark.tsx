import * as React from 'react';
import { Image } from 'expo-image';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const darkLogotype = require('@/assets/images/logotype-dark.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lightLogotype = require('@/assets/images/logotype-light.png');

export type BrandWordmarkProps = Readonly<{
    /** Height in px; width scales 5x like the existing wizard logotype. Default 32. */
    height?: number;
    testID?: string;
}>;

const logotypes = [
    { source: darkLogotype, onDark: false },
    { source: lightLogotype, onDark: true },
] as const;

/** Keep both assets loaded so a theme change can reveal the other image immediately. */
export const BrandWordmark = React.memo(function BrandWordmark(props: BrandWordmarkProps) {
    const { theme } = useUnistyles();
    const height = props.height ?? 32;
    const width = Math.round(height * 5);
    return (
        <View style={{ height, width }}>
            {logotypes.map(({ source, onDark }) => {
                const visible = theme.dark === onDark;
                return (
                    <Image
                        key={onDark ? 'on-dark' : 'on-light'}
                        testID={visible ? props.testID ?? 'brand-wordmark' : undefined}
                        accessibilityLabel={visible ? t('welcome.brandWordmarkAccessibilityLabel') : undefined}
                        aria-hidden={!visible}
                        source={source}
                        contentFit="contain"
                        contentPosition="left"
                        style={{ position: 'absolute', left: 0, top: 0, height, width, opacity: visible ? 1 : 0 }}
                    />
                );
            })}
        </View>
    );
});
