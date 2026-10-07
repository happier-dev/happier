import type { PluginUiHostApi, PluginUiWidgetAreaResultV1 } from '@happier-dev/plugin-sdk/ui';

/** Run against a native/declarative review-panel host, never hosted HTML or a plugin-owned layout store. */
export async function exerciseReviewWidgetArea(host: Pick<PluginUiHostApi, 'widgetArea'>, session: Readonly<{ serverId: string; sessionId: string }>, instanceId: string): Promise<readonly PluginUiWidgetAreaResultV1[]> {
    const context = { session };
    const results: PluginUiWidgetAreaResultV1[] = [];
    for (const operation of [
        { actionId: 'widgets.catalog.list' },
        { actionId: 'widgets.instance.add', instance: { v: 1, id: instanceId,
            definition: { kind: 'installed', surface: { pluginId: 'examples.public-sdk-review-assistant', localId: 'review-status-widget' } },
            bindings: { session: { kind: 'context', slot: 'session' } } } },
        { actionId: 'widgets.instance.inputs.validate', instanceId, bindings: { session: { kind: 'context', slot: 'session' } } },
        { actionId: 'widgets.instance.size.set', instanceId, size: 'full' },
        { actionId: 'widgets.instance.move', instanceId, toIndex: 0 },
        { actionId: 'widgets.instance.refresh', instanceId },
        { actionId: 'widgets.instance.list' },
    ] as const) {
        const result = await host.widgetArea({ area: 'pinned', context, operation });
        results.push(result);
        // Deferred approval has not executed. Do not run dependent intents until the host replays it.
        if (!result.ok || 'kind' in result.result && result.result.kind === 'approval_request_created') break;
    }
    return results;
}
