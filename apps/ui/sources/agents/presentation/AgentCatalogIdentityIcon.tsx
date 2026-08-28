import * as React from 'react';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { getAgentCore } from '@/agents/catalog/catalog';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useUnistyles } from 'react-native-unistyles';

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
    const { theme } = useUnistyles();
    const color = props.color ?? theme.colors.text.secondary;
    const packageGeneration = props.entry.installedPackage?.immutableGenerationId
        ?? props.entry.projectionGeneration;
    const scope = React.useMemo(
        () => new AbortController(),
        [
            props.current,
            props.entry.installedPackage,
            packageGeneration,
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
        expectedGeneration: packageGeneration,
        signal: scope.signal,
        accountLifetime,
        isCurrent: () => props.current && !scope.signal.aborted,
    });

    if (!props.entry.isBuiltIn) {
        return brand ? (
            <InstalledPluginBrandMark
                brand={brand}
                externallyLabelled
                size="small"
                pixelSize={props.size ?? 29}
                testID={props.testID}
            />
        ) : (
            <Icon
                name="stack-simple"
                size={props.size ?? 29}
                color={color}
                testID={props.testID}
            />
        );
    }

    const iconName = getAgentCore(props.entry.iconAgentId ?? '')?.ui.agentPickerIconName
        ?? props.entry.iconName;
    return (
        <Icon
            name={iconName as IconName}
            size={props.size ?? 29}
            color={color}
            testID={props.testID}
        />
    );
}
