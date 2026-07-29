import { definePluginUiBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = definePluginUiBuildConfig({ projectRoot: '.', outDir: 'dist/ui', targets: [
    { rendererId: 'panel-web', entry: 'ui/panel.web.tsx', kind: 'hostedWeb', platforms: ['web', 'ios', 'android', 'desktop'] },
] });
export default pluginUiBuildConfig;
