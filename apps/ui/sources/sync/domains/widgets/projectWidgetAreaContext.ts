import { WorkspaceRefV1Schema } from '@happier-dev/protocol';
import type { WidgetBindingResolutionInputV1 } from '@happier-dev/protocol/widgets';

/** Lane 12 owns portable Source identity. Existing exact Workspace refs cannot stand in for it. */
export function readProjectWidgetAreaContextV1(input: Readonly<{
    serverId: string; activeCheckout?: unknown;
}>): Readonly<{ status: 'unavailable'; reasonCode: 'widget_project_source_unavailable'; providedContext: WidgetBindingResolutionInputV1['context'] }> {
    const checkout = WorkspaceRefV1Schema.safeParse(input.activeCheckout);
    return { status: 'unavailable', reasonCode: 'widget_project_source_unavailable', providedContext: {
        project: [],
        checkout: checkout.success && checkout.data.serverId === input.serverId
            ? [{ id: checkout.data.id, serverId: checkout.data.serverId, machineId: checkout.data.machineId, rootPath: checkout.data.rootPath,
                createdAtMs: checkout.data.createdAtMs }] : [],
    } };
}
