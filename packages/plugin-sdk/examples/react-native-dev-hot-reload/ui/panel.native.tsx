import type { PluginUiRenderSurface } from '@happier-dev/plugin-sdk/ui';

export const renderSurface: PluginUiRenderSurface = ({ surface }) => ({
    type: 'Text',
    props: { children: `Edit this source and rebuild for ${surface.platform}` },
    key: null,
});
