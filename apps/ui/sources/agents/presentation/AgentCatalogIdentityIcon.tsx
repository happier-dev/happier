import * as React from 'react';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useBundledPluginBrandPresentation, useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * The one Agent catalog identity mark. External Agents use only the package
 * captured beside their qualified V2 declaration; a bundled behavior carrier
 * never lends its private brand. Missing or stale package facts stay neutral.
 */
export function AgentCatalogIdentityIcon(props: Readonly<{
    entry: ResolvedAgentCatalogEntry;
    machineId: string | null;
    serverId: string | null;
    current: boolean;
    color?: string;
    size?: number;
    testID?: string;
}>): React.ReactElement {
    const scope = React.useMemo(
        () => new AbortController(),
        [
            props.current,
            props.entry.installedPackage,
            props.entry.qualifiedId,
            props.machineId,
            props.serverId,
        ],
    );
    React.useEffect(() => () => scope.abort(), [scope]);
    const installedPackage = props.current
        && props.entry.identity
        && props.entry.installedPackage?.id === props.entry.identity.pluginId
        && props.entry.installedPackage.brand
        ? props.entry.installedPackage
        : null;
    const accountLifetime = installedPackage
        ? captureActiveServerAccountScopeLifetime()
        : null;
    const brand = useInstalledPluginBrandPresentation({
        installedPackage,
        machineId: props.machineId,
        serverId: props.serverId,
        signal: scope.signal,
        accountLifetime,
        isCurrent: () => props.current && !scope.signal.aborted,
    });

    const bundledBrand = useBundledPluginBrandPresentation(
        props.entry.isBuiltIn ? props.entry.installedPackage?.id : null,
        props.entry.title,
        props.entry.isBuiltIn ? props.entry.iconAgentId : null,
    );
    return <HappierBrandMark
        brand={brand ?? bundledBrand ?? { displayName: props.entry.title }}
        externallyLabelled size="small" pixelSize={props.size ?? 29} testID={props.testID}
    />;
}
