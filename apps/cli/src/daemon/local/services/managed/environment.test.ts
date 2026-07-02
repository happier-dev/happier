import { describe, expect, it } from 'vitest';

import { buildLocalServiceLaunchEnvironment, buildRuntimePortArgs } from './environment';

describe('buildLocalServiceLaunchEnvironment', () => {
    it('injects controlled private local-service values only', () => {
        const env = buildLocalServiceLaunchEnvironment({
            baseEnv: { EXISTING: '1' },
            host: '127.0.0.1',
            port: 5173,
            privateUrl: 'http://127.0.0.1:5173',
            previewUrl: 'https://preview.example.test',
            inject: ['PORT', 'HOST', 'HAPPIER_URL', 'HAPPIER_PREVIEW_URL'],
        });

        expect(env).toEqual({
            EXISTING: '1',
            PORT: '5173',
            HOST: '127.0.0.1',
            HAPPIER_URL: 'http://127.0.0.1:5173',
            HAPPIER_PREVIEW_URL: 'https://preview.example.test',
        });
        expect(env).not.toHaveProperty('HAPPIER_PUBLIC_URL');
    });
});

describe('buildRuntimePortArgs', () => {
    it('adds framework port flags for Vite-like adapters', () => {
        expect(buildRuntimePortArgs({
            adapter: 'vite',
            host: '127.0.0.1',
            port: 5173,
            expoLanMode: false,
        })).toEqual(['--port', '5173', '--host', '127.0.0.1', '--strictPort']);
    });

    it('does not inject HOST for Expo LAN mode', () => {
        expect(buildRuntimePortArgs({
            adapter: 'expo',
            host: '127.0.0.1',
            port: 8081,
            expoLanMode: true,
        })).toEqual(['--port', '8081']);
    });
});
