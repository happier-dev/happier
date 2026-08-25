import { defineBuildConfig } from '@happier-dev/plugin-sdk/ui/build';

export const pluginUiBuildConfig = defineBuildConfig({
  projectRoot: '.',
  outDir: 'dist/ui',
  targets: [
    {
      rendererId: 'voice-runtime-web',
      entry: 'src/voiceRuntime.tsx',
      kind: 'reactNative',
      platforms: ['web', 'ios', 'android'],
      module: {
        containerName: 'happier_plugin_acme_packed_voice_voice_runtime_web',
        modulePath: './voiceRuntime',
        exportName: 'activate',
      },
    },
  ],
});

export default pluginUiBuildConfig;
