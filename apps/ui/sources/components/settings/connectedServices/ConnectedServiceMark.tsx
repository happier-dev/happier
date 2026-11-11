import * as React from 'react';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { SvgXml } from 'react-native-svg';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveConnectedServiceBrandIconXml } from '@/agents/registry/resolveConnectedServiceBrandIconXml';
import { useBundledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/** Mark box and logo size per place: the logo fills the box it used to sit in, so alignment holds. */
const MARK_SIZES = {
    page: { box: 44, logo: 36 },
    // On a sheet's title line, bare, starting on the sheet's one left edge.
    title: { box: 20, logo: 20 },
    row: { box: 32, logo: 22 },
    card: { box: 24, logo: 18 },
    // A navigation column's row (the Credentials rail): the card's logo, drawn bare on the row's glyph edge.
    column: { box: 18, logo: 18 },
    inline: { box: 16, logo: 16 },
} as const;

/**
 * A service's brand mark, bare (no tile, fill or border: `happier-ui-craft`, user ruling 2026-09-30).
 * A plugin service draws its package's brand (the manifest's `brand`, through the one plugin brand owner);
 * services without either show a key glyph. `page` heads an entity page, `row` a service
 * block or an invitation, `card` a card, `column` a navigation column's row, `inline` sits beside text.
 */
export const ConnectedServiceMark = React.memo(function ConnectedServiceMark(props: Readonly<{
    legacyServiceId: string | null | undefined;
    /** Exact service identity selects its descriptor-owned mark without a legacy alias. */
    service?: PluginContributionIdentityV1 | null;
    /** The service's owning plugin: its packaged brand is the mark when no built-in mark exists. */
    pluginId?: string | null;
    size?: keyof typeof MARK_SIZES;
}>) {
    const { theme } = useUnistyles();
    const brandXml = resolveConnectedServiceBrandIconXml(props.service ?? props.legacyServiceId, theme);
    const pluginBrand = useBundledPluginBrandPresentation(brandXml ? null : props.service?.pluginId ?? props.pluginId);
    const size = MARK_SIZES[props.size ?? 'row'];
    const glyph = brandXml
        ? <SvgXml xml={brandXml} width={size.logo} height={size.logo} />
        : pluginBrand
            ? <HappierBrandMark brand={pluginBrand} externallyLabelled pixelSize={size.logo} />
            : <Icon name="key" size={Math.min(size.logo, 18)} color={theme.colors.text.secondary} />;
    if (props.size === 'inline' || props.size === 'column' || props.size === 'title') return glyph;
    return <View style={[styles.box, { width: size.box, height: size.box }]}>{glyph}</View>;
});

/** "Claude Code, OpenCode and Pi": the agents that sign in with a service, as a sentence. */
export function formatAgentNames(names: readonly string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return t('connectedServicesSettings.namesAnd', {
        names: names.slice(0, -1).join(', '),
        last: names[names.length - 1]!,
    });
}


const styles = StyleSheet.create(() => ({
    box: {
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
