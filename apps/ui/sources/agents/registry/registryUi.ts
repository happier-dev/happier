import type { ImageSourcePropType } from 'react-native';

import type { CanonicalAgentId } from './registryCore';
import { isBundledAgentId } from './registryCore';
import { lightTheme, darkTheme, type Theme } from '@/theme';
import type { HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

import { BUNDLED_CANONICAL_AGENTS_UI } from './generatedBundledPluginEntries';

export type AgentIconSvgXmlResolver = (
    theme: Theme,
) => string;

export type AgentUiConfig = Readonly<{
    id: string;
    identityColor?: Readonly<{ light: string; dark: string }>;
    icon: ImageSourcePropType | null;
    svgIconXml: AgentIconSvgXmlResolver | null;
    /**
     * Visual scaling for small list/picker icons (for example backend picker rows).
     * Some marks have more inherent whitespace than others; this keeps them visually consistent.
     */
    pickerIconScale?: number;
    /**
     * Optional tint for the icon (Codex icon is monochrome and should match text color).
     */
    tintColor: ((theme: Theme) => string) | null;
    /**
     * Avatar overlay sizing tweaks.
     */
    avatarOverlay: Readonly<{
        circleScale: number; // relative to avatar size
        iconScale: (params: { size: number }) => number; // absolute px derived from avatar size
    }>;
    /**
     * Text glyph used in compact CLI/profile compatibility indicators.
     */
    cliGlyph: string;
}>;

export const CANONICAL_AGENTS_UI = BUNDLED_CANONICAL_AGENTS_UI;

type AdmittedAgentUiConfig = AgentUiConfig & Readonly<{ brandArtwork?: Omit<HostCatalogMark, 'displayName'> }>;

// Owned artwork is materialized once when the bundled catalog is admitted.
// Renderers receive platform sources, never XML or a theme-dependent converter.
export const AGENTS_UI: Readonly<Partial<Record<CanonicalAgentId, AdmittedAgentUiConfig>>> = Object.freeze(
    Object.fromEntries(Object.entries(CANONICAL_AGENTS_UI).map(([id, config]) => {
        const source = (theme: Theme) => config.svgIconXml
            ? Object.freeze({ uri: `data:image/svg+xml;utf8,${encodeURIComponent(config.svgIconXml(theme))}` })
            : config.icon ?? undefined;
        const light = source(lightTheme);
        const dark = config.svgIconXml ? source(darkTheme) : light;
        return [id, { ...config, ...(light || dark ? { brandArtwork: Object.freeze({ light, dark,
            ...(config.tintColor ? { monochrome: true } : {}) }) } : {}) }];
    })),
);

const UNKNOWN_AGENT_UI: AgentUiConfig = Object.freeze({
    id: '__unknown__',
    icon: null,
    svgIconXml: null,
    pickerIconScale: 1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 1,
        iconScale: ({ size }) => size,
    },
    cliGlyph: '?',
});

export function getAgentUiConfig(agentId: string | null | undefined): AdmittedAgentUiConfig {
    // `isBundledAgentId` narrows to the key of the bundled record. An externally
    // installed Agent legitimately has no bundled presentation entry, so it gets
    // the neutral placeholder rather than an `undefined` masquerading as a config.
    if (isBundledAgentId(agentId)) {
        return AGENTS_UI[agentId] ?? UNKNOWN_AGENT_UI;
    }
    return UNKNOWN_AGENT_UI;
}

export function getAgentIconSource(agentId: string): ImageSourcePropType | null {
    return getAgentUiConfig(agentId).icon;
}

export function getAgentIconSvgXml(
    agentId: string,
    theme: Theme,
): string | null {
    const resolveSvgXml = getAgentUiConfig(agentId).svgIconXml;
    return resolveSvgXml ? resolveSvgXml(theme) : null;
}

export function getAgentIconTintColor(agentId: string, theme: Theme): string | undefined {
    const tint = getAgentUiConfig(agentId).tintColor;
    if (!tint) return undefined;
    return tint(theme);
}

export function getAgentPickerIconScale(agentId: string): number {
    const cfg = getAgentUiConfig(agentId);
    return cfg.pickerIconScale ?? 1;
}

export function getAgentAvatarOverlaySizes(agentId: string, size: number): { circleSize: number; iconSize: number } {
    const cfg = getAgentUiConfig(agentId);
    const circleSize = Math.round(size * cfg.avatarOverlay.circleScale);
    const iconSize = cfg.avatarOverlay.iconScale({ size });
    return { circleSize, iconSize };
}

export function getAgentCliGlyph(agentId: string): string {
    return getAgentUiConfig(agentId).cliGlyph;
}
