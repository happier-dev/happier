import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const AUGGIE_UI: AgentUiConfig = {
    id: 'auggie',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.auggie ?? null,
    pickerIconScale: 1.15,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.32),
    },
    cliGlyph: 'A',
};
