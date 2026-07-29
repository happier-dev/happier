import type { PluginUiRenderSurface } from '@happier-dev/plugin-sdk/ui';

export const renderSurface: PluginUiRenderSurface = ({ surface }) => ({
    type: 'Text',
    props: { children: `Installed React Native example (${surface.platform})` },
    key: null,
});
