import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const CLAUDE_UI: AgentUiConfig = {
    id: 'claude',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.claude ?? null,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.32),
    },
    // iOS can render dingbat glyphs as emoji; force text presentation (U+FE0E).
    cliGlyph: '\u2733\uFE0E',
};
