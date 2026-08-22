import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: 'dist/ui',
  targets: [
    {
      rendererId: 'packed-client-runtime',
      entry: 'src/clientRuntime.ts',
      kind: 'reactNative',
      platforms: ['web', 'ios', 'android'],
      module: {
        containerName: 'examples_packed_targeted_projection_client_runtime',
        modulePath: './clientRuntime',
        exportName: 'activate',
      },
    },
    {
      rendererId: 'provider-detail',
      entry: 'ui/providerDetail.native.tsx',
      kind: 'reactNative',
      platforms: ['web', 'ios', 'android'],
      module: {
        containerName: 'examples_packed_targeted_projection_provider_detail',
        modulePath: './renderSurface',
        exportName: 'renderSurface',
      },
    },
  ],
});

export default pluginUiBuildConfig;
