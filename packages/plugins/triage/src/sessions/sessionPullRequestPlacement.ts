import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type ActionsService, type PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { ActionSessionAddressV1Schema, type ActionSessionAddressV1 } from '@happier-dev/plugin-sdk/sessions';

const definition = { kind: 'installed', surface: { pluginId: 'happier.triage', localId: 'session-pull-request' } } as const;
type Result = 'added' | 'present' | 'unavailable';

/** Called only by acknowledged explicit link completions. It retains no work for a refresh or later mount. */
export async function ensureTriagePullRequestCompanionV1(
    actions: Pick<ActionsService, 'execute'>,
    address: ActionSessionAddressV1, accountId: string, options?: PluginCancellationOptions,
): Promise<Result> {
    try {
        if (options?.signal?.aborted) return 'unavailable';
        const session = ActionSessionAddressV1Schema.parse(address);
        const input = { surface: { serverId: session.serverId, accountId,
            owner: { kind: 'companion' as const, sessionId: session.sessionId } } } satisfies PluginActionInputById['widgets.item.list'];
        const catalog = await actions.execute('widgets.catalog.list', input, options);
        if (options?.signal?.aborted || isPluginActionApprovalRequestCreated(catalog)
            || !pluginJsonValuesEqual(catalog.surface, input.surface)
            || catalog.entries.filter(entry => entry.availability === 'available'
            && entry.definition.kind === 'installed' && entry.definition.surface.pluginId === definition.surface.pluginId
            && entry.definition.surface.localId === definition.surface.localId).length !== 1) return 'unavailable';
        const current = await actions.execute('widgets.item.list', input, options);
        if (options?.signal?.aborted || isPluginActionApprovalRequestCreated(current)
            || !pluginJsonValuesEqual(current.surface, input.surface)) return 'unavailable';
        if (current.instances.some(({ instance }) => instance.definition.kind === 'installed'
            && instance.definition.surface.pluginId === definition.surface.pluginId
            && instance.definition.surface.localId === definition.surface.localId)) return 'present';
        const result = await actions.execute('widgets.item.add', { ...input, instance: {
            v: 1, id: 'happier.triage:session-pull-request', definition,
            bindings: { session: { kind: 'value', value: session } },
        } }, options);
        return options?.signal?.aborted || isPluginActionApprovalRequestCreated(result)
            || !pluginJsonValuesEqual(result.ref.surface, input.surface) || result.instance === null ? 'unavailable' : 'added';
    } catch {
        // Placement cannot turn an acknowledged link into an apparent failed link.
        return 'unavailable';
    }
}
