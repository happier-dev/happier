import * as React from 'react';
import {
    HappierUiPlatformProvider,
    type HappierUiPlatformFacts,
} from '@happier-dev/plugin-ui/environment';
import { useUnistyles } from 'react-native-unistyles';

import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';

/**
 * The app-root adapter for the shared presentation platform capability.
 *
 * The platform resolver is the existing app owner for the shared four-platform
 * fact. This adapter deliberately supplies no locale, a11y, inset, or keyboard
 * state: those are independently-owned capabilities, and subscribing to them
 * here would turn a root platform fact into app-wide rerender churn.
 */
export function AppPresentationPlatformProvider(
    props: React.PropsWithChildren,
): React.ReactElement {
    const { theme } = useUnistyles();
    const platform = React.useMemo<HappierUiPlatformFacts>(() => ({
        platform: resolveLocalServicePreviewPlatform(),
        colorScheme: theme.dark ? 'dark' : 'light',
    }), [theme.dark]);

    return (
        <HappierUiPlatformProvider platform={platform}>
            {props.children}
        </HappierUiPlatformProvider>
    );
}
