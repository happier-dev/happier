import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';
export const pluginUiBuildConfig = defineBuildConfig({ projectRoot: '.', outDir: 'dist/ui', targets: [
    { rendererId: 'panel-web', entry: 'ui/panel.web.tsx', kind: 'hostedWeb' },
] });
export default pluginUiBuildConfig;
