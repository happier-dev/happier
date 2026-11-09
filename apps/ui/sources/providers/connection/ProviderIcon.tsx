import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { HappierBrandMark } from '@happier-dev/plugin-ui/presentation';
import { HappierBrandMark as HostBrandMark } from '@/components/ui/media/HappierBrandMark';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ICON_REGISTRY } from '@/components/ui/icons/iconRegistry.generated';

import { useBundledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { readAccountProviderDeclaration } from '@/providers/catalog/accountProviderDeclarations';

const ACCOUNT_DECLARATIONS = { kind: 'account' } as const;

function contributedIconName(value: string | null | undefined): IconName | null {
    if (!value) return null;
    return Object.hasOwn(ICON_REGISTRY, value) ? value as IconName : null;
}

/**
 * Provider identity uses the same manifest-declared packaged mark as plugin chrome, else the contributing plugin's
 * admitted first-party artwork (Anthropic is the Claude plugin's). A named contribution without artwork keeps its
 * declared glyph, else the shared bare grapheme every unmarked item draws (X3); only an unnamed one (a custom
 * Provider) draws the neutral cube.
 */
export const ProviderIcon = React.memo(function ProviderIcon(props: Readonly<{
    contributionKey?: string | null;
    icon: string | null | undefined;
    size: number;
    color: string;
}>) {
    const { theme } = useUnistyles();
    const pluginId = parseProviderContributionIdentityV1(props.contributionKey)?.identity.pluginId;
    // The bundled declaration names the contribution, which admits the plugin's artwork and names its fallback.
    const displayName = React.useMemo(() => props.contributionKey
        ? readAccountProviderDeclaration(props.contributionKey, ACCOUNT_DECLARATIONS)?.definition.name
        : undefined, [props.contributionKey]);
    const brand = useBundledPluginBrandPresentation(pluginId, displayName);
    const presentationTheme = React.useMemo(() => {
        const projected = projectPluginUiTheme(theme);
        return { ...projected, colors: { ...projected.colors, text: props.color } };
    }, [theme, props.color]);
    // Packaged bytes draw through the portable mark (tinted when monochrome); admitted first-party artwork is a
    // host platform source, which only the host binding draws.
    if (brand?.bytes) return <HappierBrandMark {...brand} size="small" pixelSize={props.size} theme={presentationTheme} externallyLabelled />;
    if (brand) return <HostBrandMark brand={brand} pixelSize={props.size} externallyLabelled />;
    const glyph = contributedIconName(props.icon);
    if (!glyph && displayName) {
        return <HappierBrandMark displayName={displayName} size="small" pixelSize={props.size} theme={presentationTheme} externallyLabelled />;
    }
    return (
        <Icon
            name={glyph ?? 'cube'}
            size={props.size}
            color={props.color}
        />
    );
});
