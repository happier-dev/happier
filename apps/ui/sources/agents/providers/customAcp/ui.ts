import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const CUSTOM_ACP_UI: AgentUiConfig = {
    id: 'customAcp',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.customAcp ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.32),
    },
    cliGlyph: 'ACP',
};
