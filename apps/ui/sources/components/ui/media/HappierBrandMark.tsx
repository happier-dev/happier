import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { HappierImageSize } from '@happier-dev/plugin-ui/presentation';

// Private same-realm binding: URI-bearing inputs never enter package exports.
import { HappierBrandMarkInternal, type HostCatalogMark } from '../../../../../../packages/plugin-ui/src/presentation/content/Image';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { SafeExpoImage } from './SafeExpoImage';

export type { HostCatalogMark };

/** Host theme/platform binding to the one identity drawing and fallback owner. */
export function HappierBrandMark(props: Readonly<{
    brand: HostCatalogMark;
    size?: HappierImageSize;
    pixelSize?: number;
    showName?: boolean;
    externallyLabelled?: boolean;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    return <HappierBrandMarkInternal
        displayName={props.brand.displayName}
        bytes={props.brand.bytes}
        source={theme.dark ? props.brand.dark ?? props.brand.light : props.brand.light}
        imageHost={SafeExpoImage}
        monochrome={props.brand.monochrome}
        size={props.size ?? (props.pixelSize === undefined ? 'medium' : 'small')}
        pixelSize={props.pixelSize}
        theme={presentationTheme}
        showName={props.showName}
        externallyLabelled={props.externallyLabelled}
        testID={props.testID}
    />;
}
