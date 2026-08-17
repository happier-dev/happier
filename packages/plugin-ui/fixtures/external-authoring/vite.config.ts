import { resolve } from 'node:path';

export default {
  build: {
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/Surface.tsx'),
      formats: ['es'],
      fileName: 'plugin-ui-surface',
    },
    outDir: process.env.HAPPIER_PLUGIN_UI_FIXTURE_OUT_DIR
      ?? resolve(import.meta.dirname, 'dist-vite'),
    rollupOptions: {
      // Host-provided singletons (§3.8): a plugin bundle that inlined React or
      // React Native would mount with two runtime worlds.
      external: ['react', 'react/jsx-runtime', 'react-native'],
    },
  },
};
