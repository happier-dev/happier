import { useSyncExternalStore } from 'react';
import { Redirect, useLocalSearchParams, useSegments, type Href } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import { subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { resolvePluginAppPageRouteAlias } from './pluginPageRouteAliases';

/** Retained Expo entrances borrow their destination from the current page declarations. */
export function PluginAppPageRouteAliasRedirect() {
    const params = useLocalSearchParams();
    const segments = useSegments();
    // Expo's pathname has decoded path operands. Its own serializer restores
    // segment boundaries before the shared matcher decodes each operand once.
    const pathname = resolveHref({ pathname: `/${segments.filter(segment => !(segment.startsWith('(') && segment.endsWith(')'))).join('/')}`, params } as Href)
        .split(/[?#]/, 1)[0]!;
    const href = useSyncExternalStore(subscribeCommittedAppShellPluginUiProjection,
        () => resolvePluginAppPageRouteAlias(pathname, params), () => null);
    return href === null ? null : <Redirect href={href as Href} />;
}
