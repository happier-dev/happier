import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { definePlugin } from '../definePlugin.js';
import { parsePluginManifest } from '../manifest.js';
import { defineUiSurfaceDefinition, type UiSurfaceReactNativeDefinition, type UiSurfaceHostedWebDefinition } from './surface.js';

describe('defineUiSurfaceDefinition', () => {
    it('admits public Machine page shorthand through the canonical manifest', () => {
        const surface = defineUiSurfaceDefinition({ id: 'machine-tools', placement: 'appPage',
            target: { kind: 'machine', serverIdPath: '/serverId', machineIdPath: '/machineId' },
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Machine tools' } } });
        const plugin = definePlugin({ id: 'com.acme.machine-tools', version: '1.0.0', ui: { surfaces: [surface] } });
        expect(parsePluginManifest(plugin.manifest).ok).toBe(true);
        expect(plugin.manifest.contributes.ui?.views?.[0]).toMatchObject({
            container: 'appPage', target: surface.target,
        });
        type MachineNativePage = Extract<UiSurfaceReactNativeDefinition, { placement: 'appPage'; target: { kind: 'machine' } }>;
        type MachineHostedPage = Extract<UiSurfaceHostedWebDefinition, { placement: 'appPage'; target: { kind: 'machine' } }>;
        expectTypeOf<MachineNativePage['target']>().toMatchTypeOf<{ kind: 'machine' }>();
        expectTypeOf<MachineHostedPage['target']>().toMatchTypeOf<{ kind: 'machine' }>();
        expectTypeOf<NonNullable<MachineNativePage['column']>>().toEqualTypeOf<never>();
    });

    it('normalizes public Project and app page shorthand through the canonical manifest and portable projection', () => {
        const renderer = { kind: 'declarative' as const, root: { kind: 'text' as const, text: 'Builds' } };
        const project = defineUiSurfaceDefinition({ id: 'builds', placement: 'appPage', target: { kind: 'project' },
            title: 'Builds', description: 'Follow the repository.',
            counts: { resourceId: 'branch-counts', items: [{ field: 'running', label: 'Running' }, { field: 'failed', label: 'Failed' }] },
            availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } }, renderer });
        const explicitApp = defineUiSurfaceDefinition({ id: 'app', placement: 'appPage', target: { kind: 'app' }, renderer });
        const implicitApp = defineUiSurfaceDefinition({ id: 'default', placement: 'appPage', renderer });
        const plugin = definePlugin({ id: 'com.acme.pages', version: '1.0.0',
            resources: { 'branch-counts': { kind: 'config', source: 'dynamic', contentType: 'application/json', scope: 'surface',
                runtime: { read: () => JSON.stringify({ running: 2, failed: 1 }), observe: () => ({ dispose() {} }) } } },
            ui: { surfaces: [project, explicitApp, implicitApp] } });
        expect(plugin.manifest.contributes.ui?.views).toMatchObject([
            { id: 'builds', container: 'appPage', target: { kind: 'project' }, description: 'Follow the repository.',
                counts: { resourceId: 'branch-counts', items: [{ field: 'running', label: 'Running' }, { field: 'failed', label: 'Failed' }] },
                availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } } },
            { id: 'app', target: { kind: 'app' } }, { id: 'default', target: { kind: 'app' } },
        ]);
        type ProjectNativePage = Extract<UiSurfaceReactNativeDefinition, { placement: 'appPage'; target: { kind: 'project' } }>;
        type ProjectHostedPage = Extract<UiSurfaceHostedWebDefinition, { placement: 'appPage'; target: { kind: 'project' } }>;
        expectTypeOf<ProjectNativePage['target']>().toMatchTypeOf<{ kind: 'project' }>();
        expectTypeOf<ProjectHostedPage['target']>().toMatchTypeOf<{ kind: 'project' }>();
        expectTypeOf<NonNullable<ProjectNativePage['column']>>().toEqualTypeOf<never>();
        expectTypeOf<NonNullable<ProjectNativePage['widgetAreas']>>().toEqualTypeOf<never>();
        type SettingsPage = Extract<UiSurfaceReactNativeDefinition, { placement: 'settingsPage' }>;
        expectTypeOf<NonNullable<SettingsPage['target']>>().toEqualTypeOf<never>();
    });
    it('publishes widget sizes from the public author definition into the canonical manifest', () => {
        const surface = defineUiSurfaceDefinition({ id: 'checks', placement: 'widget', target: { kind: 'app' },
            sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' },
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Checks' } } });
        const plugin = definePlugin({ id: 'com.acme.sizes', version: '1.0.0', ui: { surfaces: [surface] } });
        expect(plugin.manifest.contributes.ui?.views?.[0]).toMatchObject({ container: 'widget',
            sizeDeclaration: { sizes: ['medium', 'tall'], defaultSize: 'tall' } });
    });
    it('admits an external Project widget with its sizes and repository applicability through the public author definition', () => {
        const surface = defineUiSurfaceDefinition({ id: 'project-status', placement: 'widget', target: { kind: 'project' },
            sizeDeclaration: { sizes: ['medium', 'wide'], defaultSize: 'medium' },
            availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } },
            renderer: { kind: 'declarative', root: { kind: 'text', text: 'Project status' } } });
        const plugin = definePlugin({ id: 'com.acme.project-widget', version: '1.0.0', ui: { surfaces: [surface] } });
        const admitted = parsePluginManifest(plugin.manifest);
        expect(admitted.ok, admitted.ok ? undefined : JSON.stringify(admitted)).toBe(true);
        expect(plugin.manifest.contributes.ui?.views?.[0]).toMatchObject({ container: 'widget', target: { kind: 'project' },
            sizeDeclaration: { sizes: ['medium', 'wide'], defaultSize: 'medium' },
            availability: { when: { fact: 'project.repository.kind', operator: 'equals', value: 'github' } } });
    });
    it('projects executable surface identity without author-owned build metadata', () => {
        const surface = defineUiSurfaceDefinition({
            id: 'home',
            placement: 'appPage',
            title: 'Home',
            description: { key: 'home.purpose', fallback: 'Review incoming work.' },
            renderer: { kind: 'reactNative', requiredHostMethods: ['context'] },
        } satisfies UiSurfaceReactNativeDefinition);
        expectTypeOf(surface.renderer.kind).toEqualTypeOf<'reactNative'>();
        const plugin = definePlugin({
            id: 'com.acme.surface',
            version: '1.0.0',
            ui: { surfaces: [surface] },
        });
        expect(plugin.manifest.contributes.ui).toMatchObject({
            views: [{ id: 'home', container: 'appPage', renderer: 'home-renderer',
                description: { key: 'home.purpose', fallback: 'Review incoming work.' } }],
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
            renderer: { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Hello</p>') },
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
                source: artifactHtmlBundleFromBodyV1('<p>Hello</p>'),
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
