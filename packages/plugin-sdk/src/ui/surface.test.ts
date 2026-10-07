import { describe, expect, expectTypeOf, it } from 'vitest';

import { definePlugin } from '../definePlugin.js';
import { defineUiSurfaceDefinition } from './surface.js';

describe('defineUiSurfaceDefinition', () => {
    it('publishes widget sizes from the public author definition into the canonical manifest', () => {
        const surface = defineUiSurfaceDefinition({ id: 'checks', placement: 'widget', target: { kind: 'app' },
            sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' },
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Checks' } } });
        const plugin = definePlugin({ id: 'com.acme.sizes', version: '1.0.0', ui: { surfaces: [surface] } });
        expect(plugin.manifest.contributes.ui?.views?.[0]).toMatchObject({ container: 'widget',
            sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' } });
    });
    it('projects executable surface identity without author-owned build metadata', () => {
        const surface = defineUiSurfaceDefinition({
            id: 'home',
            placement: 'appPage',
            title: 'Home',
            renderer: { kind: 'reactNative', requiredHostMethods: ['context'] },
        });
        expectTypeOf(surface.renderer.kind).toEqualTypeOf<'reactNative'>();
        const plugin = definePlugin({
            id: 'com.acme.surface',
            version: '1.0.0',
            ui: { surfaces: [surface] },
        });
        expect(plugin.manifest.contributes.ui).toMatchObject({
            views: [{ id: 'home', container: 'appPage', renderer: 'home-renderer' }],
            renderers: [{
                id: 'home-renderer',
                kind: 'reactNative',
                artifact: 'home-renderer',
                requiredHostMethods: ['context'],
            }],
        });
    });

    it('projects hosted static and inline HTML through their distinct renderer contracts', () => {
        const hosted = defineUiSurfaceDefinition({
            id: 'hosted',
            placement: 'appPage',
            renderer: { kind: 'hostedWeb', requiredHostMethods: ['context'] },
        });
        const inline = defineUiSurfaceDefinition({
            id: 'inline',
            placement: 'rendererOnly',
            renderer: { kind: 'hostedHtml', source: { kind: 'html', html: '<p>Hello</p>' } },
        });
        const plugin = definePlugin({
            id: 'com.acme.hosted',
            version: '1.0.0',
            ui: { surfaces: [hosted, inline] },
        });
        expect(plugin.manifest.contributes.ui?.renderers).toEqual([
            {
                id: 'hosted-renderer',
                kind: 'hostedWeb',
                source: { kind: 'artifact', artifact: 'hosted-renderer' },
                requiredHostMethods: ['context'],
            },
            {
                id: 'inline-renderer',
                kind: 'hostedHtml',
                source: { kind: 'html', html: '<p>Hello</p>' },
            },
        ]);
    });

    it('keeps declarative renderer-only surfaces out of the view catalog', () => {
        const surface = defineUiSurfaceDefinition({
            id: 'summary',
            placement: 'rendererOnly',
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Ready' } },
        });
        const plugin = definePlugin({
            id: 'com.acme.declarative',
            version: '1.0.0',
            ui: { surfaces: [surface] },
        });
        expect(plugin.manifest.contributes.ui?.views).toBeUndefined();
        expect(plugin.manifest.contributes.ui?.renderers?.[0]).toMatchObject({
            id: 'summary-renderer',
            kind: 'declarative',
        });
    });
});
