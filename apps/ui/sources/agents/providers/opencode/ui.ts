import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const OPENCODE_UI: AgentUiConfig = {
    id: 'opencode',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.opencode ?? null,
    pickerIconScale: 0.9,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.32),
    },
    cliGlyph: '</>',
};
