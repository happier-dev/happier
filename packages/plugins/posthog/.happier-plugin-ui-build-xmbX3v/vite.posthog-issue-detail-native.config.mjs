import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { createReactNativeWebVitePlugins } from '@happier-dev/plugin-sdk/ui/build';

function createManagedLibrary() {
  return {
    entry: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/src/ui/renderSurface.tsx",
    formats: ['es'],
    fileName: () => 'entry.mjs',
  };
}

const managedConfig = {
  root: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/.happier-plugin-ui-build-xmbX3v",
  plugins: [react({ jsxRuntime: 'classic' }), ...createReactNativeWebVitePlugins()],
  resolve: {
    alias: [{ find: 'react-native', replacement: 'react-native-web' }],
  },
  build: {
    outDir: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/node_modules/.cache/happier-plugin-ui/react-native-web/posthog-issue-detail-native",
    minify: false,
    sourcemap: false,
    emptyOutDir: true,
    lib: {
      entry: "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/src/ui/renderSurface.tsx",
      formats: ['es'],
      fileName: () => 'entry.mjs',
    },
  },
};

function applyManagedReactNativeWebBuildOptions(build) {
  build.outDir = "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/node_modules/.cache/happier-plugin-ui/react-native-web/posthog-issue-detail-native";
  build.lib = createManagedLibrary();
  build.rollupOptions ??= {};
  delete build.rollupOptions.input;
  delete build.rollupOptions.output;
  build.rollupOptions.external = [];
}

async function assertBoundedAuthorViteConfig(authorConfig) {
  const pending = [authorConfig?.plugins];
  while (pending.length > 0) {
    const candidate = await pending.pop();
    if (candidate == null || candidate === false) continue;
    if (Array.isArray(candidate)) {
      pending.push(...candidate);
      continue;
    }
    if (typeof candidate === 'object' && candidate.configResolved != null) {
      throw new Error('Managed plugin UI Vite extensions must not register configResolved; managed root, entry, output, externals, and package identity are finalized by the builder.');
    }
  }
}

const managedConfigGuard = {
  name: 'happier-plugin-ui-managed-vite-config-guard',
  enforce: 'post',
  config: {
    order: 'post',
    handler(config) {
      config.root = "/Users/leeroy/Documents/Development/happier/dev/packages/plugins/posthog/.happier-plugin-ui-build-xmbX3v";
      config.build ??= {};
      applyManagedReactNativeWebBuildOptions(config.build);
    },
  },
  configEnvironment: {
    order: 'post',
    handler(name, config) {
      if (name !== 'client') return;
      config.build ??= {};
      applyManagedReactNativeWebBuildOptions(config.build);
    },
  },
};

managedConfig.plugins = [...managedConfig.plugins, managedConfigGuard];

export default defineConfig(managedConfig);
