import { definePlugin, type PluginClientApi, type PluginDragSourceRuntime, type PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import type { PluginClientActionHandler } from '@happier-dev/plugin-sdk/actions';
import { defineProtocolJsonValue, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

export const plugin = definePlugin({
    id: 'com.acme.entity-author', version: '1.0.0',
    actions: { add: {
        title: 'Collect for review',
        execution: { target: 'client', client: { artifactId: 'entity-runtime', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] },
        surfaces: ['ui'],
        inputSchema: defineProtocolObject({ item: defineProtocolJsonValue() }, { policy: 'closed' }),
        resultSchema: defineProtocolObject({ collected: defineProtocolJsonValue() }, { policy: 'closed' }),
    } },
    dragSources: { issue: { title: 'Issue', referenceSchema: { type: 'string' }, client: { artifactId: 'entity-runtime', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] } },
    dropTargets: { review: { title: 'Review', acceptedKinds: ['session', 'repository-file', 'plugin:com.acme.entity-author/issue'], actions: [{ kind: 'plugin', action: 'add' }], client: { artifactId: 'entity-runtime', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] } },
});

const source: PluginDragSourceRuntime = { describe: reference => typeof reference === 'string' ? { title: reference } : null };
const target: PluginDropTargetRuntime = { resolve: ({ item }) => {
    const title = item.kind === 'session' ? item.address.sessionId
        : item.kind === 'repository-file' ? item.path
        : item.kind === 'plugin' && item.contribution.pluginId === plugin.manifest.id
            && item.contribution.localId === 'issue' && typeof item.reference === 'string' ? item.reference
        : null;
    return title === null
        ? { status: 'refused', reason: { code: 'unavailable', message: 'This reference cannot be collected here' } }
        : { status: 'allowed', effect: { actionId: 'plugin:com.acme.entity-author/add', input: { item }, preview: { verb: 'Collect', target: title } } };
} };

// The fixture acknowledges the carried envelope; it performs no outward writes.
const add: PluginClientActionHandler = input => ({ collected: input });

export function activate(api: PluginClientApi): void {
    api.dragSources.register('issue', source);
    api.dropTargets.register('review', target);
    api.actions.register('add', add);
}

if (false) {
    // @ts-expect-error Client-only drag/drop activation never receives daemon/session capabilities.
    void (null as unknown as PluginClientApi).agents;
}
