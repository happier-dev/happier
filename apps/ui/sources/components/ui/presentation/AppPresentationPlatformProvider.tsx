import * as React from 'react';
import {
    HappierUiPlatformProvider,
    HappierUiThemeProvider,
    type HappierUiPlatformFacts,
} from '@happier-dev/plugin-ui/environment';
import { useUnistyles } from 'react-native-unistyles';

import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

/** The platform provider's host-private presentation projection; the author ABI stays unchanged. */
const HostPlatformProvider: React.ComponentType<
    React.ComponentProps<typeof HappierUiPlatformProvider> & Readonly<{ presentationActive: boolean }>
> = HappierUiPlatformProvider;

/**
 * The app-root adapter for the shared presentation platform and theme capabilities.
 *
 * The platform resolver is the existing app owner for the shared four-platform
 * fact, and the plugin theme projector supplies the prepared native surface table.
 * This adapter deliberately supplies no locale, a11y, inset, or keyboard
 * state: those are independently-owned capabilities, and subscribing to them
 * here would turn a root platform fact into app-wide rerender churn.
 *
 * It does supply whether anyone can see the host ({@link useHostActivelyViewed}),
 * so shared presentation motion (skeleton pulse, spinners, status dots) holds
 * still in a hidden window. Only this provider renders on that change; its
 * children are the caller's elements and only motion consumers re-render.
 */
export function AppPresentationPlatformProvider(
    props: React.PropsWithChildren,
): React.ReactElement {
    const { theme } = useUnistyles();
    const projectedTheme = usePluginUiTheme(theme);
    const hostActivelyViewed = useHostActivelyViewed();
    const platform = React.useMemo<HappierUiPlatformFacts>(() => ({
        platform: resolveLocalServicePreviewPlatform(),
        colorScheme: theme.dark ? 'dark' : 'light',
    }), [theme.dark]);

    return (
        <HappierUiThemeProvider theme={projectedTheme}>
            <HostPlatformProvider platform={platform} presentationActive={hostActivelyViewed}>
                {props.children}
            </HostPlatformProvider>
        </HappierUiThemeProvider>
    );
}
