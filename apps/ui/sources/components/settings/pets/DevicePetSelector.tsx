import * as React from 'react';
import {
    Platform,
    useWindowDimensions,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    DEVICE_PET_GRID_HORIZONTAL_PADDING,
    DEVICE_PET_TILE_GAP,
} from './devicePetSelector/constants';
import {
    DevicePetTileCard,
    resolveFallbackTileWidthStyle,
} from './devicePetSelector/DevicePetTileCard';
import { buildDevicePetTiles } from './devicePetSelector/buildDevicePetTiles';
import { resolveDevicePetGridColumns } from './devicePetSelector/layout';
import type { DevicePetSelectorProps } from './devicePetSelector/types';

export type {
    AccountDevicePetSelectorItem,
    DetectedDevicePetSelectorItem,
    DevicePetSelectorProps,
    LocalDevicePetSelectorItem,
} from './devicePetSelector/types';

export function DevicePetSelector(props: DevicePetSelectorProps): React.ReactElement {
    const {
        builtInPets,
        companionSizeScale,
        selectedBuiltInPetId,
        localPets,
        detectedPets = [],
        accountPets = [],
        gridTestID = 'settings-pets-device-pet-grid',
        contentsTestID = 'settings-pets-built-in-card-grid',
        onSelectBuiltInPet,
    } = props;
    const [measuredWidth, setMeasuredWidth] = React.useState(0);
    const { width: windowWidth } = useWindowDimensions();
    const webViewportWidth =
        Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.innerWidth === 'number'
            ? window.innerWidth
            : null;
    const fallbackWidth = webViewportWidth ?? windowWidth;

    const tiles = React.useMemo(() => buildDevicePetTiles({
        builtInPets,
        accountPets,
        detectedPets,
        localPets,
        onSelectBuiltInPet,
        selectedBuiltInPetId,
    }), [accountPets, builtInPets, detectedPets, localPets, onSelectBuiltInPet, selectedBuiltInPetId]);

    const columns = React.useMemo(() => {
        const width = measuredWidth > 0 ? measuredWidth : fallbackWidth;
        return resolveDevicePetGridColumns(width, tiles.length);
    }, [fallbackWidth, measuredWidth, tiles.length]);

    const tileWidth = React.useMemo(() => {
        if (measuredWidth <= 0) return null;
        const availableWidth = Math.max(0, measuredWidth - (DEVICE_PET_GRID_HORIZONTAL_PADDING * 2));
        return Math.floor((availableWidth - DEVICE_PET_TILE_GAP * (columns - 1)) / columns);
    }, [columns, measuredWidth]);

    const fallbackTileWidthStyle = React.useMemo<StyleProp<ViewStyle>>(() => {
        if (tileWidth != null) return null;
        return resolveFallbackTileWidthStyle(columns);
    }, [columns, tileWidth]);

    return (
        <View
            testID={gridTestID}
            onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
            style={styles.grid}
        >
            <View testID={contentsTestID} style={styles.gridContents}>
                {tiles.map((tile) => (
                    <DevicePetTileCard
                        key={tile.key}
                        companionSizeScale={companionSizeScale}
                        tile={tile}
                        widthStyle={tileWidth != null ? { width: tileWidth } : fallbackTileWidthStyle}
                    />
                ))}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    grid: {
        width: '100%',
    },
    gridContents: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: DEVICE_PET_TILE_GAP,
        paddingHorizontal: DEVICE_PET_GRID_HORIZONTAL_PADDING,
        paddingVertical: 10,
        width: '100%',
    },
});
