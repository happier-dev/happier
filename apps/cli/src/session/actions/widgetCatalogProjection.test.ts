import { describe, expect, it } from 'vitest';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/resolvePluginContributions';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createStablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { readCliWidgetCatalogProjectionV1 } from './widgetCatalogProjection';

describe('headless widget catalog projection', () => {
    it('offers both execution targets and retains available localized descriptors from the real registry producer', () => {
        const pluginId = 'test.widget-catalog';
        const parsed = ingestCanonicalPluginManifest(JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Widgets',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { ui: { views: [
                { id: 'app', container: 'widget', target: { kind: 'app' }, renderer: 'content', title: { key: 'widget.app', fallback: 'App widget' } },
                { id: 'session', container: 'widget', target: { kind: 'session' }, renderer: 'content', title: 'Session widget', sessionInputPath: 'session',
                  inputs: { fields: [{ path: 'session', title: 'Session', widget: 'select', optionsSourceId: 'sessions.list' }] }, inputSchema: { type: 'object', properties: { session: { type: 'object' } } } },
            ], renderers: [{ id: 'content', kind: 'declarative', root: { kind: 'text', text: 'Widget' } }] } },
        }), { sourceProvenance: 'registryCustodied' });
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        const loaded: LoadedPlugin = { pluginId, pluginRootPath: '/plugins/widgets', manifestPath: '/plugins/widgets/.happier-plugin/plugin.json',
            daemonEntryPath: '/plugins/widgets/daemon.mjs', devDaemonEntryPath: null,
            sourceSpec: { kind: 'path', locator: '/plugins/widgets', trustPolicy: 'local_trusted', installPolicy: 'link' }, manifest: parsed.manifest };
        const declarations = projectLoadedPluginContributes({ loadResult: { loadedPlugins: [loaded], diagnosticsByPluginId: {} }, provenance: 'first_party' });
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const registry = createResolvedContributionRegistry({ ...declarations, occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
        const model = createStablePluginDeclarativeModel({
            pluginId, occurrenceId,
            renderer: { id: 'content', kind: 'declarative', root: { kind: 'text', text: 'Widget' } },
            settings: [], actions: [],
        });
        const projection = buildPluginProjectionV2({ registry, generation: 1,
            pluginUiHostRuntime: { declarative: { modelsByRendererKey: { [`${pluginId}\0content`]: model } } },
        });
        expect(readCliWidgetCatalogProjectionV1(projection).filter(candidate => 'definition' in candidate)).toMatchObject([
            { definition: { kind: 'builtin', id: 'session_summary' }, target: 'session', sessionInputPath: 'session' },
            { definition: { kind: 'builtin', id: 'agent_plan' } },
            { definition: { kind: 'builtin', id: 'changes' } },
            { definition: { kind: 'builtin', id: 'local_services' } },
        ]);
        expect(readCliWidgetCatalogProjectionV1(projection).filter(candidate => candidate.surface)).toMatchObject([
            { key: `${pluginId}/app`, title: 'App widget', target: 'app', availability: 'available' },
            { key: `${pluginId}/session`, title: 'Session widget', target: 'session', availability: 'available' },
        ]);
    });
});
