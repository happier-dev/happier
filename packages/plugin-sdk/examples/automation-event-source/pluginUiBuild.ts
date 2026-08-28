import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: 'dist/ui',
  targets: [{
    rendererId: 'repository-picker',
    entry: 'ui/repositoryPicker.web.ts',
    kind: 'hostedWeb',
  }],
});

export default pluginUiBuildConfig;
