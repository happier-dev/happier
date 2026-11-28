import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    HAPPIER_MEDIA_GRID_METRICS,
    HappierMediaGridRow,
    HappierMediaTileSkeleton,
    resolveHappierMediaGridGeometry,
} from '@happier-dev/plugin-ui/presentation';

const SKELETON_ROWS = 3;
const ROWS = Array.from({ length: SKELETON_ROWS }, (_, row) => row);

/**
 * The gallery while its first listing (or its code) is on its way (lab pr974 SM1l): the grid's own squares at the
 * host's column count, so nothing moves when the pictures arrive. Light on purpose: the Files hosts draw it as the
 * lazy gallery body's fallback before that module has loaded.
 */
export function GallerySkeleton(props: Readonly<{ insetPx: number; header?: React.ReactNode; testID?: string }>) {
    const [width, setWidth] = React.useState<number | null>(null);
    const { columns, tilePx } = resolveHappierMediaGridGeometry(Math.max(0, (width ?? 0) - props.insetPx * 2));
    return (
        <View style={styles.fill} testID={props.testID}
            onLayout={(event) => {
                const next = event.nativeEvent.layout.width;
                setWidth(current => current !== null && Math.abs(current - next) < 0.5 ? current : next);
            }}>
            {props.header ?? null}
            {width === null ? null : (
                <View style={[styles.content, { paddingHorizontal: props.insetPx }]}>
                    <View style={styles.heading} />
                    {ROWS.map(row => (
                        <HappierMediaGridRow key={row}>
                            {Array.from({ length: columns }, (_, column) => (
                                <HappierMediaTileSkeleton key={column} sizePx={tilePx} testID="gallery-skeleton-tile" />
                            ))}
                        </HappierMediaGridRow>
                    ))}
                </View>
            )}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    fill: { flex: 1, minHeight: 0 },
    content: { paddingBottom: theme.space.s16 },
    heading: { height: HAPPIER_MEDIA_GRID_METRICS.headingPadTopPx + 18 + HAPPIER_MEDIA_GRID_METRICS.headingPadBottomPx },
}));
