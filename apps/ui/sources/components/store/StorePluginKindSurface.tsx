import * as React from 'react';
import type { StoreKindLaunchInputV1 } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { resolveStoreKindContribution } from './catalog/storeKindContributions';
import type { StoreKindSurfaceInput } from './StoreKindSurface';

export default function PluginStoreKindSurface(props: Readonly<{ kind: string; input: StoreKindSurfaceInput }>) {
    const projection = useAppShellPluginUiProjection();
    const router = useRouter();
    const navigation = usePluginSurfaceDestinationNavigationBinding();
    const resolved = resolveStoreKindContribution(props.kind, projection.pluginUiProjection);
    const pluginId = resolved && 'pluginId' in resolved ? resolved.pluginId : parseQualifiedPluginContributionKey(props.kind)?.pluginId ?? null;
    const recoveryAction = React.useMemo(() => ({ label: t('settingsPlugins.managePlugin'),
        onPress: () => { if (pluginId) router.push(buildPluginDetailRoute('settings', pluginId)); },
    }), [pluginId, router]);
    const binding = React.useMemo(() => navigation?.openSurface ? { openSurface: navigation.openSurface } : {}, [navigation?.openSurface]);
    const input = props.input;
    const definition = resolved && 'definition' in resolved ? resolved.definition : null;
    const sourceId = input.mode === 'listing' ? input.selection.sourceId : undefined;
    const itemId = input.mode === 'listing' ? input.selection.itemId : undefined;
    const version = input.mode === 'listing' ? input.selection.version : undefined;
    const query = input.mode === 'listing' ? undefined : input.query;
    const filters = input.mode === 'listing' ? undefined : input.filters;
    const launchInput = React.useMemo(() => {
        if (!definition || !pluginId) return null;
        // Mapping the admitted record preserves the canonical operation key set.
        const operations = Object.fromEntries(Object.entries(definition.operations).map(([role, id]) =>
            [role, buildQualifiedPluginContributionKey({ pluginId, localId: id })])) as typeof definition.operations;
        const storeInput: StoreKindLaunchInputV1 = { store: { mode: input.mode,
            ...(input.mode === 'listing' ? { selection: { sourceId: sourceId!, itemId: itemId!, ...(version ? { version } : {}) } }
                : query === undefined ? {} : { query }),
            operations,
            ...(filters ? { filters } : {}),
        } };
        return projectNativeJsonValueForTransport(storeInput);
    }, [definition, pluginId, input.mode, sourceId, itemId, version, query, filters]);
    const content = !resolved || !('placement' in resolved) || !resolved.placement || !launchInput ? <SurfaceStateCard
        testID="store.kind.unavailable" kind="unavailable" size={input.mode === 'listing' ? input.size : 'page'}
        title={t('common.unavailable')} action={pluginId ? recoveryAction : undefined} />
        : <PluginSurfaceFocusEligibilityProvider active={input.presented} presentationActive={input.presented}>
        <PluginSurfacePlacementHost placement={resolved.placement} pluginUiProjection={projection.pluginUiProjection}
            machineId={projection.machineId} serverId={projection.serverId} platform={projection.platform}
            binding={binding} launchInput={launchInput} unavailableAction={recoveryAction} />
    </PluginSurfaceFocusEligibilityProvider>;
    return <>
        <PluginSurfaceProjectionDemand pluginId={pluginId ?? undefined} presents="allInstallations" accountScope={projection.accountLifetime?.scope ?? null}
            enabled={input.presented && pluginId !== null} />
        {content}
    </>;
}
