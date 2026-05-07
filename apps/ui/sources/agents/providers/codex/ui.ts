import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const CODEX_UI: AgentUiConfig = {
    id: 'codex',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.codex ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.32),
    },
    cliGlyph: '꩜',
};
