import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const KIRO_UI: AgentUiConfig = {
    id: 'kiro',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.kiro ?? null,
    pickerIconScale: 1.25,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.22),
    },
    cliGlyph: 'KR',
};
