import * as React from 'react';
import type { PluginSurfaceTarget } from '@happier-dev/plugin-sdk/ui';
import { normalizePluginUiSubPathV1, PluginUiDestinationReferenceV1Schema } from '@happier-dev/protocol/plugins/ui';

import { useAppShellPluginUiPageProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { usePluginPageCatalogActivationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { buildPluginPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { resolvePluginPageForRoute, selectPluginPagePlacements, usePluginPages } from '@/components/plugins/pages/pluginPages';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

type EnvironmentTarget = Extract<PluginSurfaceTarget, { kind: 'deploymentEnvironment' }>;

/** The Environment read owns the addressed record. Plugin admission and rendering stay with the shared page host. */
export function DeploymentEnvironmentPluginPages(props: Readonly<{
    target: EnvironmentTarget;
    lifetime: ServerAccountScopeLifetime;
}>): React.ReactElement | null {
    const { target, lifetime } = props;
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    const openPage = usePluginPageCatalogActivationHandler();
    const projection = useAppShellPluginUiPageProjection();
    const locale = usePreferredLanguage();
    const localize = usePluginLocalizedTextResolver({ locale, projection: projection.pluginUiProjection });
    const account = projection.accountLifetime;
    const sameAccount = account?.isCurrent() === true && lifetime.isCurrent()
        && account.scope.accountId === lifetime.scope.accountId
        && areServerProfileIdentifiersEquivalent(account.scope.serverId, target.serverId);
    const placements = React.useMemo(() => sameAccount
        ? selectPluginPagePlacements(projection.pluginUiProjection, { container: 'appPage', targetKind: target.kind })
        : [], [sameAccount, projection.pluginUiProjection, target.kind]);
    const pages = usePluginPages({ target, placements, localize });
    const selected = PluginUiDestinationReferenceV1Schema.safeParse({
        pluginId: params.deploymentPlugin, localId: params.deploymentPluginPage,
    });
    const page = selected.success ? resolvePluginPageForRoute({ pages, ...selected.data }) : null;
    const routePathFor = React.useCallback((subPath: string, view: string | null) =>
        buildPluginPageRoutePath({ ...target, pluginId: page!.pluginId, localId: page!.localId, subPath, view }), [target, page]);
    if (pages.length === 0) return null;
    if (page) {
        const subPath = typeof params.deploymentPluginPath === 'string'
            ? normalizePluginUiSubPathV1(params.deploymentPluginPath) : '';
        const view = typeof params.deploymentPluginView === 'string' ? params.deploymentPluginView : null;
        return <PluginPageContent {...{ page, projection, subPath }}
            deploymentEnvironment={target} isHostCurrent={lifetime.isCurrent}
            views={pages} initialView={view} pluginId={page.pluginId} localId={page.localId}
            routePathFor={routePathFor} />;
    }

    return <PluginSurfaceFocusEligibilityProvider active>
        {pages.map(page => <ItemGroup key={page.id} title={page.label} description={page.description}
            action={<SectionActionButton testID={`environment-plugin-page-expand:${page.id}`}
                title={t('common.expand')} destination onPress={() => openPage(page)} />}>
            <PluginSurfacePlacementHost
                placement={page.placement}
                deploymentEnvironment={target}
                serverId={target.serverId}
                platform={projection.platform}
                pluginUiProjection={projection.pluginUiProjection}
                isHostCurrent={lifetime.isCurrent}
                projectionInteractionEnabled={projection.phase === 'current' && projection.interactionEnabled}
            />
        </ItemGroup>)}
    </PluginSurfaceFocusEligibilityProvider>;
}
