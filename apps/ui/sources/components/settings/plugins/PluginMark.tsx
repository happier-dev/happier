import * as React from 'react';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';
import type { PluginProjectionInstalledPackageV2 } from '@happier-dev/protocol';

import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useInstalledPluginBrandPresentation, type InstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
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
    if (props.installedPackage?.brand?.state === 'available' && props.machineId) {
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
    const bindings = useServerCredentialAccountScopeBindings(input.serverId ? [input.serverId] : []);
    const accountLifetime = input.serverId
        ? bindings.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime();
    const controller = React.useMemo(() => new AbortController(), [input.installedPackage, input.machineId, input.serverId, accountLifetime]);
    React.useEffect(() => () => controller.abort(), [controller]);
    return useInstalledPluginBrandPresentation({
        installedPackage: input.installedPackage,
        machineId: input.machineId,
        serverId: input.serverId,
        accountLifetime,
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted && accountLifetime?.isCurrent() === true,
    });
}

function ResolvedPluginMark(props: PluginMarkProps) {
    const brand = useServerInstalledPluginBrand(props);
    return <PluginIdentityMark {...props} brand={brand} />;
}

function PluginIdentityMark(props: PluginMarkProps) {
    const page = props.size === 'page';
    const mark = <InstalledPluginBrandMark
        brand={props.brand ?? { displayName: props.title }} pluginId={props.pluginId} iconAgentId={props.iconAgentId}
        pixelSize={28} externallyLabelled testID={props.testID}
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
