import * as React from 'react';
import { HAPPIER_PAGE_METRICS, HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useBundledPluginBrandPresentation, useInstalledPluginBrandPresentation, type InstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/** Generic plugin category chrome (package identities use the brand owner below). */
export const PLUGIN_GLYPH = 'puzzle-piece' as const;

type PluginMarkProps = Readonly<{
    title: string;
    pluginId?: string | null;
    /** The Agent this plugin contributes, when it has a known mark (projection `iconAgentId`). */
    iconAgentId?: string | null;
    size?: 'row' | 'page';
    dimmed?: boolean;
    testID?: string;
    brand?: InstalledPluginBrandPresentation | null;
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    machineId?: string | null;
    serverId?: string | null;
}>;

/** The same packaged-brand/Agent identity in cards, rows and headers, without a backing tile. */
export const PluginMark = React.memo(function PluginMark(props: PluginMarkProps) {
    if (props.installedPackage?.source.kind === 'bundled' || (props.installedPackage?.brand?.state === 'available' && props.machineId)) {
        return <ResolvedPluginMark {...props} />;
    }
    return <PluginIdentityMark {...props} />;
});

/**
 * An installed package's packaged brand, read on one machine for one Home (or the active Account),
 * for any host chrome that shows that package's identity. Null until the mark is read or when it has none.
 */
export function useServerInstalledPluginBrand(input: Readonly<{
    installedPackage?: PluginProjectionInstalledPackageV2 | null;
    machineId?: string | null;
    serverId?: string | null;
}>): InstalledPluginBrandPresentation | null {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const activeHome = input.serverId
        ? selectActiveServerAccountScopeForServer(activeLifetime?.scope ?? null, input.serverId) !== null
        : true;
    // The applied Home already owns proven Account custody. Only routed Homes
    // need a credential read; resolving the active Home separately per mark
    // produces an asynchronous admission/render cascade when a shelf opens.
    const bindings = useServerCredentialAccountScopeBindings(!activeHome && input.serverId ? [input.serverId] : []);
    const credentialBinding = !activeHome && input.serverId ? bindings.values().next().value ?? null : null;
    const accountLifetime = activeHome ? activeLifetime : credentialBinding;
    const controller = React.useMemo(() => new AbortController(), [input.installedPackage, input.machineId, input.serverId, accountLifetime]);
    React.useEffect(() => () => controller.abort(), [controller]);
    return useInstalledPluginBrandPresentation({
        installedPackage: input.installedPackage,
        machineId: input.machineId,
        serverId: input.serverId,
        accountLifetime,
        ...(credentialBinding ? { credentialAccountScope: credentialBinding.scope } : {}),
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted && accountLifetime?.isCurrent() === true,
    });
}

function ResolvedPluginMark(props: PluginMarkProps) {
    const brand = useServerInstalledPluginBrand(props);
    return <PluginIdentityMark {...props} brand={brand} />;
}

/** The catalog row's bare logo inside its mark box (S10 catalogRow), so a plugin row's mark matches its neighbours'. */
const ROW_MARK_PX = 26;

function PluginIdentityMark(props: PluginMarkProps) {
    const bundledBrand = useBundledPluginBrandPresentation(props.installedPackage ? null : props.pluginId, props.title, props.iconAgentId);
    const page = props.size === 'page';
    const mark = <HappierBrandMark
        brand={props.brand ?? bundledBrand ?? { displayName: props.title }}
        pixelSize={page ? HAPPIER_PAGE_METRICS.pageHeaderMarkGlyphPx : ROW_MARK_PX} externallyLabelled testID={props.testID}
    />;
    if (page) {
        return (
            <PageHeaderMarkSlot testID={props.testID} size="page">
                {mark}
            </PageHeaderMarkSlot>
        );
    }
    return (
        <HappierCollectionListMark {...(props.dimmed ? { dimmed: true } : {})}>
            {mark}
        </HappierCollectionListMark>
    );
}
