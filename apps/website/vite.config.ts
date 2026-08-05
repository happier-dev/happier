import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    css: {
        postcss: {
            plugins: [tailwindcss, autoprefixer],
        },
    },
    server: {
        port: 5173,
        host: true,
        allowedHosts: ['localhost', '127.0.0.1', '100.79.179.31', 'leeroy-mbp'],
        // stats.happier.dev allowlists only the production origins for CORS, so a
        // direct fetch from localhost is always blocked and the counters can only
        // ever show their fallbacks in dev. Proxying makes it same-origin.
        // See statsUrl() in src/components/publicStats.ts.
        proxy: {
            '/__stats': {
                target: 'https://stats.happier.dev',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/__stats/, ''),
            },
        },
    },
});
