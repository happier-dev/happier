import type { AgentUiConfig } from '@/agents/registry/registryUi';

export const GROK_UI: AgentUiConfig = {
    id: 'grok',
    icon: null,
    // The official asset download is the only permitted logo source and is currently blocked by
    // its CDN. Keep the host fallback rather than shipping a modified or third-party recreation.
    svgIconXml: null,
    pickerIconScale: 1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.31),
    },
    cliGlyph: 'GX',
};
