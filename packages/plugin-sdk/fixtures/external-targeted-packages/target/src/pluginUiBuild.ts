import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: 'dist/ui',
  targets: [{
    rendererId: 'physical-copy-target-react-renderer',
    entry: 'src/surface.tsx',
    kind: 'reactNative',
    platforms: ['web', 'ios', 'android'],
    module: {
      containerName: 'fixture_physical_copy_target_react',
      modulePath: './renderPhysicalCopyTargetSurface',
      exportName: 'renderPhysicalCopyTargetSurface',
    },
  }],
});

export default pluginUiBuildConfig;
