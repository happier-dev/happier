import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { UsageActionInputById, WidgetsActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1 } from '@happier-dev/plugin-sdk/ui/build';

/** An external widget consumes the host input type, not a plugin-owned query schema or picker. */
export const manifest = {
    schemaVersion: 2,
    id: 'acme.usage-query',
    version: '1.0.0',
    displayName: 'Usage query authoring example',
    runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_SCAFFOLD_BINDINGS_V1.toolchain.runtime) as 1 },
    contributes: { ui: {
        views: [{
            id: 'usage', container: 'widget', target: { kind: 'app' }, renderer: 'usage-summary', title: 'Usage',
            sizeDeclaration: { sizes: ['small', 'medium', 'wide', 'full', 'tall', 'large'], defaultSize: 'medium' },
            inputs: { fields: [
                // The host validates the assembled query. Children remain independently bindable.
                { path: 'query', title: 'Query', widget: 'json', inputType: { hostType: 'usageQuery' } },
                { path: 'query.period', title: 'Period', widget: 'select', required: true,
                    inputType: { hostType: 'usageQuery', field: 'period' }, contextMode: 'follow' },
                { path: 'query.agents', title: 'Agents', widget: 'text_list', required: true, contextMode: 'follow' },
                { path: 'query.machines', title: 'Machines', widget: 'text_list', required: true, contextMode: 'follow' },
                { path: 'query.projects', title: 'Projects', widget: 'text_list', required: true, contextMode: 'follow' },
                { path: 'query.sources', title: 'Sources', widget: 'text_list', required: true, contextMode: 'follow' },
                { path: 'query.session', title: 'Session', widget: 'select', required: true,
                    inputType: { hostType: 'usageQuery', field: 'session' }, contextMode: 'follow' },
                { path: 'query.costBasis', title: 'Cost basis', widget: 'select', required: true, contextMode: 'follow',
                    options: [{ value: 'auto', label: 'Automatic' }, { value: 'reported', label: 'Reported' },
                        { value: 'estimated', label: 'Estimated' }, { value: 'api_equivalent', label: 'API equivalent' }] },
                { path: 'query.metric', title: 'Metric', widget: 'select', required: true, contextMode: 'own',
                    options: [{ value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' }] },
                { path: 'query.breakdown', title: 'Breakdown', widget: 'multiselect', required: true, contextMode: 'own',
                    options: [{ value: 'model', label: 'Model' }, { value: 'agent', label: 'Agent' }] },
            ] },
            // Only the widget's envelope is author-owned; UsageQuery validation stays with the host.
            inputSchema: { type: 'object', properties: { query: { type: 'object' } },
                required: ['query'], additionalProperties: false },
        }],
        renderers: [{ id: 'usage-summary', kind: 'declarative',
            root: { kind: 'status', label: 'Usage', value: 'Waiting for admitted usage.' } }],
    } },
} satisfies PluginManifest;

/** Pin the period and presentation while independently following the current host scope. */
export const bindings = {
    'query.period': { kind: 'value', value: { startMs: 1790812800000, endMs: 1790899200000 } },
    'query.agents': { kind: 'context', slot: 'agents' },
    'query.machines': { kind: 'context', slot: 'machines' },
    'query.projects': { kind: 'context', slot: 'projects' },
    'query.sources': { kind: 'context', slot: 'sources' },
    'query.session': { kind: 'context', slot: 'session' },
    'query.costBasis': { kind: 'context', slot: 'costBasis' },
    'query.metric': { kind: 'value', value: 'cost' },
    'query.breakdown': { kind: 'value', value: ['model'] },
} satisfies WidgetsActionInputById['widgets.item.add']['instance']['bindings'];

/** Invalidation carries no usage bytes; readers use the same admitted host-read reference. */
export function watchUsage(
    host: Pick<PluginUiHostApi, 'watchResource'>,
    query: UsageActionInputById['usage.query']['queries'][number] & JsonValue,
    listener: Parameters<PluginUiHostApi['watchResource']>[1],
    options?: Parameters<PluginUiHostApi['watchResource']>[2],
): ReturnType<PluginUiHostApi['watchResource']> {
    return host.watchResource({ hostRead: 'usage.query', input: { queries: [query] } }, listener, options);
}
