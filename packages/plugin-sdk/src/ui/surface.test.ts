import { describe, expect, expectTypeOf, it } from 'vitest';

import { definePlugin } from '../definePlugin.js';
import { defineBuildConfig } from './build/config.js';
import {
    buildUiSurfaceTargets,
    defineUiSurfaceDefinition,
} from './surface.js';
/* @sdk-negative-type-case:src-ui-surface-test-ts-legacy-declaration-helper:dGhlIFNESyBkZWNsYXJhdGlvbiBoZWxwZXIgd2FzIHJlbmFtZWQgYmVmb3JlIHB1YmxpY2F0aW9uOyB0aGUgYXJ0aWZhY3QgZW50cnkgb3ducyBkZWZpbmVVaVN1cmZhY2Uu:aW1wb3J0IHsgZGVmaW5lVWlTdXJmYWNlIH0gZnJvbSAnLi9zdXJmYWNlLmpzJzs= */
void undefined; /* @sdk-negative-type-case-end */

if (false) {
    /* @sdk-negative-type-case:src-ui-surface-test-ts-right-pane-app:cmlnaHRQYW5lIGhhcyBubyBhcHAgdGFyZ2V0IGJpbmRpbmc7IHRoZSBzaG9ydGhhbmQgbXVzdCBwcmVzZXJ2ZSB0aGUgUHJvdG9jb2wgcmVsYXRpb24u:ZGVmaW5lVWlTdXJmYWNlRGVmaW5pdGlvbih7CiAgICAgICAgaWQ6ICdpbnZhbGlkLWFwcC1wYW5lJywKICAgICAgICBwbGFjZW1lbnQ6ICdyaWdodFBhbmUnLAogICAgICAgIHRhcmdldDogeyBraW5kOiAnYXBwJyB9LAogICAgICAgIHJlbmRlcmVyOiB7IGtpbmQ6ICdob3N0ZWRXZWInIH0sCiAgICAgICAgYnVpbGQ6IHsgZW50cnk6ICd1aS9pbnZhbGlkLnRzJyB9LAogICAgfSk7 */
    void undefined; /* @sdk-negative-type-case-end */
}

describe('defineUiSurfaceDefinition', () => {
    it('publishes the unambiguous declaration helper', () => {
        const surface = defineUiSurfaceDefinition({
            id: 'declaration-name',
            placement: 'appPage',
            title: 'Declaration name',
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Ready' } },
        });

        expect(surface.id).toBe('declaration-name');
    });

    it('projects one executable surface declaration into matching cold manifest and build targets', () => {
        const app = defineUiSurfaceDefinition({
            id: 'home',
            placement: 'appPage',
            title: 'Home',
            renderer: {
                kind: 'reactNative',
                requiredHostMethods: ['context', 'executeAction'],
            },
            build: {
                entry: 'ui/HomeSurface.tsx',
                platforms: ['web', 'ios', 'android'],
                module: {
                    containerName: 'acme_home',
                    modulePath: './HomeSurface',
                    exportName: 'renderSurface',
                },
            },
        });
        const settings = defineUiSurfaceDefinition({
            id: 'settings',
            placement: 'settingsPage',
            group: { kind: 'host', id: 'general' },
            title: 'Settings',
            renderer: {
                kind: 'hostedWeb',
                requiredHostMethods: ['context'],
            },
            build: {
                entry: 'ui/settings.ts',
            },
        });
        const project = defineUiSurfaceDefinition({
            id: 'project-review',
            placement: 'rightSidebarTab',
            target: { kind: 'project' },
            title: 'Project review',
            renderer: {
                kind: 'hostedWeb',
            },
            build: {
                entry: 'ui/projectReview.ts',
            },
        });
        const session = defineUiSurfaceDefinition({
            id: 'session-details',
            placement: 'detailsTab',
            target: { kind: 'session' },
            title: 'Session details',
            renderer: {
                kind: 'declarative',
                root: { kind: 'text', text: 'Details' },
            },
        });

        expectTypeOf(app.renderer.kind).toEqualTypeOf<'reactNative'>();
        expectTypeOf(app.build.entry).toEqualTypeOf<'ui/HomeSurface.tsx'>();

        expect(buildUiSurfaceTargets(app)).toEqual([{
            kind: 'reactNative',
            rendererId: 'home-renderer',
            entry: 'ui/HomeSurface.tsx',
            platforms: ['web', 'ios', 'android'],
            module: {
                containerName: 'acme_home',
                modulePath: './HomeSurface',
                exportName: 'renderSurface',
            },
        }]);
        expect(buildUiSurfaceTargets(settings)).toEqual([{
            kind: 'hostedWeb',
            rendererId: 'settings-renderer',
            entry: 'ui/settings.ts',
        }]);
        expect(buildUiSurfaceTargets(project)).toEqual([{
            kind: 'hostedWeb',
            rendererId: 'project-review-renderer',
            entry: 'ui/projectReview.ts',
        }]);
        expect(buildUiSurfaceTargets(session)).toEqual([]);

        const build = defineBuildConfig({
            targets: [
                ...buildUiSurfaceTargets(app),
                ...buildUiSurfaceTargets(settings),
                ...buildUiSurfaceTargets(project),
            ],
        });
        const plugin = definePlugin({
            id: 'com.acme.ui-surface',
            version: '1.0.0',
            ui: {
                surfaces: [app, settings, project, session],
            },
        });

        expect(build.targets.map(({ rendererId }) => rendererId)).toEqual([
            'home-renderer',
            'settings-renderer',
            'project-review-renderer',
        ]);
        expect(plugin.manifest.contributes.ui).toMatchObject({
            views: [
                {
                    id: 'home',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'home-renderer',
                },
                {
                    id: 'project-review',
                    container: 'rightSidebarTab',
                    target: { kind: 'project' },
                    renderer: 'project-review-renderer',
                },
                {
                    id: 'session-details',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'session-details-renderer',
                },
            ],
            settingsPages: [{
                id: 'settings',
                renderer: 'settings-renderer',
            }],
            renderers: [
                {
                    id: 'home-renderer',
                    kind: 'reactNative',
                    artifact: 'home-renderer',
                    requiredHostMethods: ['context', 'executeAction'],
                },
                {
                    id: 'settings-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'settings-renderer' },
                    requiredHostMethods: ['context'],
                },
                {
                    id: 'project-review-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'project-review-renderer' },
                },
                {
                    id: 'session-details-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Details' },
                },
            ],
        });
    });

    it('projects a placement-free renderer-only surface without synthesizing a view', () => {
        const composerRenderer = defineUiSurfaceDefinition({
            id: 'composer-picker',
            placement: 'rendererOnly',
            renderer: {
                kind: 'reactNative',
                requiredHostMethods: ['context', 'readComposer', 'applyComposer'],
            },
            build: {
                entry: 'ui/ComposerPicker.tsx',
                platforms: ['web', 'ios', 'android'],
                module: {
                    containerName: 'acme_composer_picker',
                    modulePath: './ComposerPicker',
                    exportName: 'renderSurface',
                },
            },
        });

        expect(buildUiSurfaceTargets(composerRenderer)).toEqual([{
            kind: 'reactNative',
            rendererId: 'composer-picker-renderer',
            entry: 'ui/ComposerPicker.tsx',
            platforms: ['web', 'ios', 'android'],
            module: {
                containerName: 'acme_composer_picker',
                modulePath: './ComposerPicker',
                exportName: 'renderSurface',
            },
        }]);

        const plugin = definePlugin({
            id: 'com.acme.composer-renderer',
            version: '1.0.0',
            ui: { surfaces: [composerRenderer] },
        });
        expect(plugin.manifest.contributes.ui).toMatchObject({
            renderers: [{
                id: 'composer-picker-renderer',
                kind: 'reactNative',
                artifact: 'composer-picker-renderer',
            }],
        });
        expect(plugin.manifest.contributes.ui?.views).toBeUndefined();
        expect(plugin.manifest.contributes.ui?.settingsPages).toBeUndefined();
    });

    it('fails closed instead of synthesizing a build target for an undeclared executable surface build', () => {
        expect(() => buildUiSurfaceTargets({
            id: 'missing-build',
            placement: 'appPage',
            renderer: { kind: 'reactNative' },
        } as never)).toThrow('defineUiSurfaceDefinition executable surface missing-build requires build metadata');
    });
});
