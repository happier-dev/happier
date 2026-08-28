import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export default defineBuildConfig({
  projectRoot: '.',
  outDir: 'dist/ui',
  targets: [{
    rendererId: 'qa-native',
    entry: 'ui/nativeSurface.tsx',
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: {
      containerName: 'happier_qa_current_source_native',
      modulePath: './renderSurface',
      exportName: 'renderSurface',
    },
  }, {
    rendererId: 'qa-hosted',
    entry: 'ui/hostedSurface.ts',
    kind: 'hostedWeb',
  }],
});
