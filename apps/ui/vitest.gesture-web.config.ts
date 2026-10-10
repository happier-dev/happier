import { mergeConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import base from './vitest.config';

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Exercise the shipped web recognizer, not the callback-recording native test adapter.
const config = mergeConfig(base, {
    resolve: {
        extensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.jsx', '.json'],
        alias: [
            { find: /^react-native-gesture-handler$/, replacement: resolve('./node_modules/react-native-gesture-handler/src/index.ts') },
            { find: /^react-native$/, replacement: resolve('./node_modules/react-native-web/dist/index.js') },
        ],
    },
    test: {
        environment: 'jsdom',
        server: { deps: { inline: [/react-native-gesture-handler/, /react-native-web/] } },
    },
});

// Vite merges arrays, so replace (rather than append to) the ordinary suite inventory.
config.test!.include = ['sources/**/*.gestureWeb.real.integration.test.tsx'];
config.test!.exclude = [];
export default config;
