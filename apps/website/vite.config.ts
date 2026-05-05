import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * `@/...` → apps/website/src. The demo store owns its own loose-typed
 * copies of Session/Message/Metadata shapes — apps/ui's strict types stay
 * inside apps/demo's mocks (which reshape data on the way out to real
 * apps/ui components). This keeps the marketing bundle free of RN-Web
 * transitive baggage.
 */
export default defineConfig({
    plugins: [react() as PluginOption],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src'),
        },
    },
    server: {
        port: 3001,
        strictPort: false,
    },
});
