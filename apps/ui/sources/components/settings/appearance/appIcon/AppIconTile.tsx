import * as React from 'react';
import type { ImageSourcePropType } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native-unistyles';

/**
 * Rendered from the same artwork as the native icons (`app-icons/<id>/tile@2x|3x.png`). A switch of
 * static requires, so the bundler can see each asset and nothing loads until a tile renders.
 */
function tileImage(iconId: string): ImageSourcePropType | null {
    switch (iconId) {
        case 'default': return require('@/assets/images/app-icons/default/tile.png');
        case 'night': return require('@/assets/images/app-icons/night/tile.png');
        case 'paper': return require('@/assets/images/app-icons/paper/tile.png');
        case 'gold': return require('@/assets/images/app-icons/gold/tile.png');
        case 'aurora': return require('@/assets/images/app-icons/aurora/tile.png');
        case 'sunrise': return require('@/assets/images/app-icons/sunrise/tile.png');
        case 'blueprint': return require('@/assets/images/app-icons/blueprint/tile.png');
        case 'pixel': return require('@/assets/images/app-icons/pixel/tile.png');
        default: return null;
    }
}

const TILE_SIZE = 64;

/**
 * An app icon at home-screen proportions. Like an app icon, it does not change with the theme;
 * only its hairline edge does, so a white icon still has an edge on a white sheet.
 */
export const AppIconTile = React.memo(function AppIconTile(props: Readonly<{ iconId: string }>) {
    const source = tileImage(props.iconId);
    if (!source) return null;
    return <Image source={source} style={styles.tile} contentFit="cover" accessible={false} />;
});

const styles = StyleSheet.create((theme) => ({
    tile: {
        width: TILE_SIZE,
        height: TILE_SIZE,
        // The iOS icon mask's corner at this size (22.37 % of the side).
        borderRadius: Math.round(TILE_SIZE * 0.2237),
        borderCurve: 'continuous',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
}));
