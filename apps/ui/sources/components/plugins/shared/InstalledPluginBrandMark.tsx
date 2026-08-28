import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    HappierBrandMark,
    resolveHappierImagePixels,
    type HappierImageSize,
} from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';

export type InstalledPluginBrandMarkProps = Readonly<{
    brand: InstalledPluginBrandPresentation;
    size?: HappierImageSize;
    /** Exact host-chrome slot size; packaged UI surfaces otherwise use the named size scale. */
    pixelSize?: number;
    /** An adjacent host-owned label already supplies the one canonical name. */
    externallyLabelled?: boolean;
    testID?: string;
}>;

/**
 * App-private host chrome composition for an already-resolved installed package
 * brand. It does not know package identity, read bytes, create a plugin surface,
 * or own a Resource lifecycle; those facts stay in the adapter and daemon.
 */
export function InstalledPluginBrandMark(props: InstalledPluginBrandMarkProps): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const mark = (
        <HappierBrandMark
            displayName={props.brand.displayName}
            bytes={props.brand.bytes}
            size={props.size}
            externallyLabelled={props.externallyLabelled}
            theme={presentationTheme}
            colorScheme={theme.dark ? 'dark' : 'light'}
            testID={props.pixelSize === undefined ? props.testID : undefined}
        />
    );
    if (props.pixelSize === undefined) return mark;

    const namedSize = props.size ?? 'small';
    const basePixels = resolveHappierImagePixels(namedSize);
    const pixelSize = Math.max(1, props.pixelSize);
    return (
        <View
            style={{
                width: pixelSize,
                height: pixelSize,
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
            }}
            testID={props.testID}
        >
            <View
                style={{
                    width: basePixels,
                    height: basePixels,
                    transform: [{ scale: pixelSize / basePixels }],
                }}
            >
                {mark}
            </View>
        </View>
    );
}
