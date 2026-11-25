import type { PluginWorkItemsResolveRequestV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsWatchRequestV1 } from '@happier-dev/protocol/plugins/contributions/workItems';
import { PluginWorkItemsResolveRequestV1Schema, PluginWorkItemsResolveResultV1Schema, PluginWorkItemsFindLinkedRequestV1Schema, PluginWorkItemsFindLinkedResultV1Schema, PluginWorkItemsWatchRequestV1Schema } from '@happier-dev/protocol/plugins/contributions/workItems';

/** Trusted executable callbacks keep their receiver; Protocol owns result identities. */
export function normalizeWorkItemsRuntime(value: unknown) {
    // Registration accepts trusted plugin code; restore its executable shape
    // here while validating the data crossing the WorkItems protocol boundary.
    const receiver = value as {
        resolve(request: PluginWorkItemsResolveRequestV1, context: unknown): unknown;
        findLinked?(request: PluginWorkItemsFindLinkedRequestV1, context: unknown): unknown;
        watch?(request: PluginWorkItemsWatchRequestV1, onChange: () => void, context: unknown): unknown;
    };
    return {
        async resolve(request: unknown, context: unknown) {
            const input = PluginWorkItemsResolveRequestV1Schema.parse(request);
            const result = PluginWorkItemsResolveResultV1Schema.parse(await receiver.resolve(input, context));
            const ids = new Set(input.itemIds);
            if (Object.keys(result).some(id => !ids.has(id))) {
                throw new TypeError('Work item resolver returned an unrequested item');
            }
            return Object.freeze(Object.fromEntries(input.itemIds.map(id => [id, Object.hasOwn(result, id) ? result[id]! : null])));
        },
        ...(receiver.findLinked ? { async findLinked(request: unknown, context: unknown) {
            return PluginWorkItemsFindLinkedResultV1Schema.parse(await receiver.findLinked!(PluginWorkItemsFindLinkedRequestV1Schema.parse(request), context));
        } } : {}),
        ...(receiver.watch ? { watch(request: unknown, onChange: () => void, context: unknown) {
            const cleanup = receiver.watch!(PluginWorkItemsWatchRequestV1Schema.parse(request), onChange, context);
            if (typeof cleanup !== 'function') throw new TypeError('Work items runtime.watch must return cleanup');
            return cleanup;
        } } : {}),
    };
}
