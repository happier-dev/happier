import * as React from 'react';
import {
    HappierUiPlatformProvider,
    HappierUiThemeProvider,
    type HappierUiPlatformFacts,
} from '@happier-dev/plugin-ui/environment';
import { useUnistyles } from 'react-native-unistyles';

import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

/**
 * The app-root adapter for the shared presentation platform and theme capabilities.
 *
 * The platform resolver is the existing app owner for the shared four-platform
 * fact, and the plugin theme projector supplies the prepared native surface table.
 * This adapter deliberately supplies no locale, a11y, inset, or keyboard
 * state: those are independently-owned capabilities, and subscribing to them
 * here would turn a root platform fact into app-wide rerender churn.
 */
export function AppPresentationPlatformProvider(
    props: React.PropsWithChildren,
): React.ReactElement {
    const { theme } = useUnistyles();
    const projectedTheme = usePluginUiTheme(theme);
    const platform = React.useMemo<HappierUiPlatformFacts>(() => ({
        platform: resolveLocalServicePreviewPlatform(),
        colorScheme: theme.dark ? 'dark' : 'light',
    }), [theme.dark]);

    return (
        <HappierUiThemeProvider theme={projectedTheme}>
            <HappierUiPlatformProvider platform={platform}>
                {props.children}
            </HappierUiPlatformProvider>
        </HappierUiThemeProvider>
    );
}
