import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const reactNativeWebEntry = resolve(root, 'node_modules/react-native-web/dist/index.js');

export default {
  root,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react-native$/u, replacement: reactNativeWebEntry },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: process.env.HAPPIER_PLUGIN_UI_BROWSER_OUT_DIR
      ?? resolve(root, 'dist-browser'),
  },
};
