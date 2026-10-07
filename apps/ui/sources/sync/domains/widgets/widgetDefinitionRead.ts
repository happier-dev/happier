import { getActionSpec, type PublicActionResultById } from '@happier-dev/protocol/actions/actionSpecs';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { WidgetDefinitionRefV1, WidgetDefinitionV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

export async function readWidgetDefinitionForInstanceV1(
    executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>,
    scope: WidgetSurfaceRefV1,
    reference: WidgetDefinitionRefV1,
    signal?: AbortSignal,
): Promise<WidgetDefinitionV1 | null> {
    signal?.throwIfAborted();
    if (reference.kind === 'inline') return reference.definition;
    if (reference.kind !== 'artifact') return null;
    const result = await executor.execute('widgets.definition.get', {
        account: { serverId: scope.serverId, accountId: scope.accountId }, artifactId: reference.artifactId,
    }, { surface: 'ui', serverId: scope.serverId, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    if (!result.ok) {
        if (result.errorCode === 'widget_definition_not_found') return null;
        throw Object.assign(new Error(result.error), { code: result.errorCode ?? 'widget_definition_unavailable' });
    }
    const output = getActionSpec('widgets.definition.get').outputSchema!.parse(result.result) as PublicActionResultById['widgets.definition.get'];
    return output.definition;
}
