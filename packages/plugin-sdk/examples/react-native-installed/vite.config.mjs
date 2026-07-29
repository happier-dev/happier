import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { defineConfig } from 'vite';
import { createReactNativeWebVitePlugins } from '@happier-dev/plugin-sdk/ui/build';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [...createReactNativeWebVitePlugins()],
    resolve: {
        alias: [{ find: 'react-native', replacement: 'react-native-web' }],
    },
    build: {
        outDir: join(projectRoot, 'dist/ui/react-native-web/panel-native'),
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        lib: {
            entry: join(projectRoot, 'ui/panel.native.tsx'),
            formats: ['es'],
            fileName: () => 'entry.mjs',
        },
    },
});
