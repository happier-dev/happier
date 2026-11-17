import * as React from 'react';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

export type BrandWordmarkProps = Readonly<{
    /** Height in px; width scales 5x like the existing wizard logotype. Default 32. */
    height?: number;
    testID?: string;
}>;

/**
 * The Happier wordmark for the unauth brand pane. Theme-aware: in dark mode
 * we render the light (white) logotype against the dark canvas + dark planet;
 * in light mode we render the dark (black) logotype against the cream canvas
 * + warm planet. Mirrors `WizardLogotype`'s asset-swap pattern so the brand
 * pane reads clearly in both themes.
 */
export const BrandWordmark = React.memo(function BrandWordmark(props: BrandWordmarkProps) {
    const { theme } = useUnistyles();
    const height = props.height ?? 32;
    const width = Math.round(height * 5);
    const styles = stylesheet;
    return (
        <Image
            testID={props.testID ?? 'brand-wordmark'}
            // The wordmark is where the brand pane names Happier: it is read as the name, not skipped as art.
            accessibilityLabel={t('welcome.brandWordmarkAccessibilityLabel')}
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            source={theme.dark
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                ? require('@/assets/images/logotype-light.png')
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                : require('@/assets/images/logotype-dark.png')}
            contentFit="contain"
            // The drawn mark starts on the box's edge, level with the copy under it.
            contentPosition="left"
            style={[styles.image, { height, width }]}
        />
    );
});

const stylesheet = StyleSheet.create(() => ({
    image: {
        // intentionally empty; size is driven by height/width props.
    },
}));
