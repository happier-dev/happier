import { describe, expect, it } from 'vitest';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { buildPluginProjectionV2 } from '@/plugins/projection/registry/projection/v2';
import { createStablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { readCliWidgetCatalogProjectionV1 } from './widgetCatalogProjection';
import { describeWidgetAreaApprovalSurfaceV1 } from '@happier-dev/protocol/widgets';

describe('headless widget catalog projection', () => {
    it('offers both execution targets and retains available localized descriptors from the real registry producer', () => {
        const pluginId = 'test.widget-catalog';
        const parsed = ingestCanonicalPluginManifest(JSON.stringify({ schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Widgets',
            engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 }, entrypoints: { daemon: './daemon.mjs' },
            contributes: { ui: { views: [
                { id: 'overview', container: 'appPage', target: { kind: 'app' }, renderer: 'content', title: { key: 'page.title', fallback: 'Widget areas' },
                  widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object' } }] },
                { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'app', container: 'widget', target: { kind: 'app' }, renderer: 'content', title: { key: 'widget.app', fallback: 'App widget' } },
                { sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' }, id: 'session', container: 'widget', target: { kind: 'session' }, renderer: 'content', title: 'Session widget', sessionInputPath: 'session',
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
        expect(readCliWidgetCatalogProjectionV1(projection).filter(candidate => 'definition' in candidate)).toEqual(expect.arrayContaining([
            expect.objectContaining({ definition: { kind: 'builtin', id: 'session_summary' }, target: 'session',
                fields: expect.arrayContaining([expect.objectContaining({ path: 'session', inputType: { hostType: 'session' }, required: true })]) }),
            expect.objectContaining({ definition: { kind: 'builtin', id: 'agent_plan' } }),
            expect.objectContaining({ definition: { kind: 'builtin', id: 'changes' } }),
            expect.objectContaining({ definition: { kind: 'builtin', id: 'local_services' } }),
        ]));
        expect(readCliWidgetCatalogProjectionV1(projection).filter(candidate => candidate.surface)).toMatchObject([
            { key: `${pluginId}/app`, title: 'App widget', target: 'app', availability: 'available' },
            { key: `${pluginId}/session`, title: 'Session widget', target: 'session', availability: 'available' },
        ]);
        const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'pluginArea', pluginId, pageId: 'overview', area: 'pinned' } } as const;
        const entries = Object.values(projection.familiesById.pluginUi?.entriesById ?? {});
        expect(describeWidgetAreaApprovalSurfaceV1(surface, entries)).toEqual({ pageName: 'Widget areas', areaName: 'Pinned' });
        expect(describeWidgetAreaApprovalSurfaceV1(surface, [...entries, ...entries])).toBeNull();
        expect(describeWidgetAreaApprovalSurfaceV1({ ...surface, owner: { ...surface.owner, pluginId: 'another.plugin' } }, entries)).toBeNull();
    });
});
