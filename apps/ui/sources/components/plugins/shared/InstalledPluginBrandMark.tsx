import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
    HappierBrandMark,
    type HappierImageSize,
} from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';

export type InstalledPluginBrandMarkProps = Readonly<{
    brand: InstalledPluginBrandPresentation;
    size?: HappierImageSize;
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
    return (
        <HappierBrandMark
            displayName={props.brand.displayName}
            bytes={props.brand.bytes}
            size={props.size}
            externallyLabelled={props.externallyLabelled}
            theme={presentationTheme}
            colorScheme={theme.dark ? 'dark' : 'light'}
            testID={props.testID}
        />
    );
}
