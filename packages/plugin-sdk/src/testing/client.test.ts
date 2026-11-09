import { describe, expect, it } from 'vitest';
import { definePlugin } from '../definePlugin.js';
import type { PluginClientApi } from '../activation.js';
import { parsePluginManifest } from '../manifest.js';
import * as testing from './index.js';

const target = { artifactId: 'client-actions', exportName: 'activate', platform: 'web' } as const;
const plugin = definePlugin({ id: 'acme.client-testkit', version: '1.0.0', actions: {
    read: { title: 'Read', surfaces: ['ui'], execution: { target: 'client',
        client: { artifactId: target.artifactId, exportName: target.exportName }, platforms: ['web'] } },
    other: { title: 'Other', surfaces: ['ui'], execution: { target: 'client',
        client: { artifactId: 'other-client', exportName: 'activate' }, platforms: ['web'] } },
} });

describe('public client activation testkit', () => {
    it('activates only the declared client target and retires registrations with cleanup', async () => {
        expect(parsePluginManifest(plugin.manifest).ok).toBe(true);
        expect(typeof testing.createPluginClientTestkit).toBe('function');
        let api!: PluginClientApi;
        let cleanups = 0;
        const handler = () => ({ read: true });
        const fixture = await testing.createPluginClientTestkit({ manifest: plugin.manifest, target,
            activate(clientApi: PluginClientApi) {
                api = clientApi;
                clientApi.actions.register('read', handler);
                return () => { cleanups++; };
            } });
        expect(fixture.registrations()).toEqual([{ family: 'actions', localId: 'read' }]);
        expect(fixture.registration('actions', 'read')).toBe(handler);
        expect(fixture.registration('actions', 'other')).toBeUndefined();
        await fixture.dispose();
        await fixture.dispose();
        expect(cleanups).toBe(1);
        expect(fixture.registrations()).toEqual([]);
        expect(fixture.registration('actions', 'read')).toBeUndefined();
        expect(() => api.actions.register('read', handler)).toThrow();
    });

    it.each([
        { ...target, artifactId: 'wrong-client' },
        { ...target, exportName: 'wrong-export' },
        { ...target, platform: 'ios' as const },
    ])('does not borrow another artifact/export/platform registration right: %j', async (selected) => {
        await expect(testing.createPluginClientTestkit({ manifest: plugin.manifest, target: selected,
            activate(api: PluginClientApi) { api.actions.register('read', () => null); },
        })).rejects.toThrow();
    });

    it('cleans and retires a client activation whose commit is incomplete', async () => {
        let api!: PluginClientApi;
        let cleaned = false;
        await expect(testing.createPluginClientTestkit({ manifest: plugin.manifest, target,
            activate(clientApi: PluginClientApi) {
                api = clientApi;
                return () => { cleaned = true; };
            },
        })).rejects.toThrow();
        expect(cleaned).toBe(true);
        expect(() => api.actions.register('read', () => null)).toThrow();
    });
});
