import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    HappierBrandMark,
    resolveHappierImagePixels,
    type HappierImageSize,
} from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { hasAgentIconMark } from '@/agents/catalog/catalog';
import { resolveBundledAgentIdFromPluginId } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { AgentIcon } from '@/agents/registry/AgentIcon';

import type { InstalledPluginBrandPresentation } from './installedPluginBrandPresentation';

export type InstalledPluginBrandMarkProps = Readonly<{
    brand: InstalledPluginBrandPresentation;
    pluginId?: string | null;
    /** Explicit catalog artwork for host chrome; never inferred from an external package's backing Agent. */
    iconAgentId?: string | null;
    size?: HappierImageSize;
    /** Exact host-chrome slot size; packaged UI surfaces otherwise use the named size scale. */
    pixelSize?: number;
    /** An adjacent host-owned label already supplies the one canonical name. */
    externallyLabelled?: boolean;
    testID?: string;
}>;

/**
 * App-private host chrome composition for an already-resolved installed package
 * brand. Exact bundled package identity reuses the incumbent Agent artwork.
 * It does not read bytes, create a plugin surface,
 * or own a Resource lifecycle; those facts stay in the adapter and daemon.
 */
export function InstalledPluginBrandMark(props: InstalledPluginBrandMarkProps): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const namedSize = props.size ?? (props.pixelSize === undefined ? 'medium' : 'small');
    const agentId = props.iconAgentId ?? resolveBundledAgentIdFromPluginId(props.pluginId);
    if (!props.brand.bytes && agentId && hasAgentIconMark(agentId, theme)) {
        const pixels = resolveHappierImagePixels(namedSize, props.pixelSize);
        return (
            <View
                testID={props.testID}
                style={{ width: pixels, height: pixels }}
                accessible={!props.externallyLabelled}
                accessibilityLabel={props.externallyLabelled ? undefined : props.brand.displayName}
                accessibilityElementsHidden={props.externallyLabelled}
                importantForAccessibility={props.externallyLabelled ? 'no-hide-descendants' : undefined}
                aria-hidden={props.externallyLabelled || undefined}
            >
                <AgentIcon agentId={agentId} size={pixels} />
            </View>
        );
    }
    return (
        <HappierBrandMark
            displayName={props.brand.displayName}
            bytes={props.brand.bytes}
            size={namedSize}
            pixelSize={props.pixelSize}
            externallyLabelled={props.externallyLabelled}
            theme={presentationTheme}
            monochrome={props.brand.monochrome}
            testID={props.testID}
        />
    );
}
