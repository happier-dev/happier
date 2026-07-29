import { describe, expect, it } from 'vitest';

import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';

import { projectLoadedPluginContributes } from './resolvePluginContributions';

describe('resolved plugin resource projection', () => {
    it('retains the canonical package root needed for contained generation admission', () => {
        const pluginId = 'com.acme.resources';
        const pluginRootPath = `/plugins/${pluginId}`;
        const loaded: LoadedPlugin = {
            pluginId,
            pluginRootPath,
            manifestPath: `${pluginRootPath}/.happier-plugin/plugin.json`,
            manifestDigest: `sha256:${'a'.repeat(64)}`,
            daemonEntryPath: null,
            devDaemonEntryPath: null,
            sourceSpec: { kind: 'archive', locator: `${pluginId}.tgz`, trustPolicy: 'prompt', installPolicy: 'copy' },
            manifest: normalizePluginManifestV2({
                schemaVersion: 2,
                id: pluginId,
                version: '1.0.0',
                displayName: 'Resources',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                contributes: {
                    resources: [{
                        id: 'review', kind: 'prompt', path: 'resources/review.md',
                        digest: `sha256:${'b'.repeat(64)}`, contentType: 'text/markdown',
                    }],
                    agents: [{
                        id: 'reviewer', title: 'Reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
                        capabilities: { surfaces: ['terminal'], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                    }],
                    promptAssets: [{
                        id: 'review-instructions', kind: 'systemPrompt', resource: 'review',
                        target: { kind: 'agent', agent: 'reviewer' },
                    }],
                },
            }),
        };

        const projected = projectLoadedPluginContributes({
            loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} },
            provenance: 'external',
        });

        expect(projected.resources).toMatchObject([{
            pluginId,
            pluginRootPath,
            source: { kind: 'archive' },
            definition: { id: 'review', path: 'resources/review.md' },
        }]);
        expect(projected.promptAssets).toMatchObject([{
            pluginId,
            identity: { pluginId, localId: 'review-instructions' },
            definition: {
                resource: 'review',
                target: { kind: 'agent', agent: 'reviewer' },
            },
        }]);
    });
});
