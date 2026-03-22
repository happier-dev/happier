import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const QWEN_UI: AgentUiConfig = {
    id: 'qwen',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.qwen ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.35,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.25),
    },
    cliGlyph: 'Q',
};
