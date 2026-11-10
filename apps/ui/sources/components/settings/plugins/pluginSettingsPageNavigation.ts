import * as React from 'react';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';

import type {
    PluginSurfaceDestinationContainerHandler,
    PluginSurfaceDestinationOpenResolution,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import { usePluginSurfaceWindowPresentation } from '@/components/plugins/surfaces/pluginSurfaceWindowPresentation';
import type {
    PluginUiProjectionModel,
    PluginUiSettingsPageProjection,
} from '@/sync/domains/plugins/ui/projection';
import { normalizePluginUiSubPathV1 } from '@happier-dev/protocol/plugins/ui';
import { getPreferredLanguage } from '@/text';
import { withInternalRouteQueryParams } from '@/utils/path/routeUtils';
import { SETTINGS_RETURN_QUERY_PARAM } from '../navigation/settingsRouteRegistry';

import {
    pluginSettingsPageRoute,
    resolveAdmittedPluginSettingsPage,
} from '../catalog/runtime/pluginSettingsPageCatalog';

function unavailable(reason: string) {
    return { ok: false as const, code: 'unavailable' as const, reason };
}

/**
 * The Settings container adapter for the one qualified destination resolver.
 *
 * It accepts only the resolver-selected Settings-page projection, confirms that
 * the existing Settings catalog still admits that exact projected record, and
 * then asks the incumbent router to visit the host-generated route. It owns no
 * page catalog, route grammar, selection, or pending launch-input state.
 */
export function createPluginSettingsPageDestinationHandler(input: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    locale: string;
    pathname: string;
    navigate: (routePath: string) => void;
    openWindow?: (routePath: string) => Promise<PluginSurfaceOpenOutcome>;
}>): PluginSurfaceDestinationContainerHandler<PluginUiSettingsPageProjection> {
    return (resolution: PluginSurfaceDestinationOpenResolution<PluginUiSettingsPageProjection>) => {
        if (resolution.placement.binding.container !== 'settingsPage') {
            return unavailable('plugin_surface_open_destination_owner_unavailable');
        }
        const page = resolveAdmittedPluginSettingsPage({
            projection: input.projection,
            pluginId: resolution.placement.binding.destination.pluginId,
            pageId: resolution.placement.binding.destination.localId,
            locale: input.locale,
        });
        // The resolver is the qualified binding owner and the Settings catalog
        // owns route admission. Requiring the same projection record means a
        // similarly named page cannot substitute during an async projection
        // change or collision.
        if (!page || page.page.id !== resolution.placement.id) {
            return unavailable('plugin_surface_open_destination_unknown');
        }
        const pagePath = pluginSettingsPageRoute(
            page.page.pluginId,
            page.page.descriptorId,
        );
        // The caller's plugin-local location rides as the page route's `subPath` param, the same one
        // `replacePageLocation` writes, so the page opens where it was asked to.
        const subPath = normalizePluginUiSubPathV1(resolution.request.subPath ?? '') ?? '';
        const routePath = subPath === '' ? pagePath : withInternalRouteQueryParams(pagePath, { subPath });
        if (resolution.request.presentation === 'window') {
            return input.openWindow?.(routePath) ?? {
                ok: false, code: 'unsupported_method', reason: 'plugin_surface_open_window_unsupported',
            };
        }
        if (subPath !== '' || pagePath !== input.pathname) {
            const fromSettings = input.pathname === '/settings' || input.pathname.startsWith('/settings/');
            input.navigate(fromSettings ? routePath : withInternalRouteQueryParams(routePath, {
                [SETTINGS_RETURN_QUERY_PARAM]: '1',
            }));
        }
        return { ok: true };
    };
}

/** The sole React adapter from an admitted Settings route to host navigation. */
export function usePluginSettingsPageDestinationHandler(input: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
}>): PluginSurfaceDestinationContainerHandler<PluginUiSettingsPageProjection> {
    const router = useRouter();
    const pathname = usePathname();
    const locale = getPreferredLanguage();
    const openWindow = usePluginSurfaceWindowPresentation();
    return React.useMemo(() => createPluginSettingsPageDestinationHandler({
        projection: input.projection,
        locale,
        pathname,
        openWindow,
        navigate: (routePath) => {
            router.push(routePath as Parameters<typeof router.push>[0]);
        },
    }), [input.projection, locale, pathname, router, openWindow]);
}
