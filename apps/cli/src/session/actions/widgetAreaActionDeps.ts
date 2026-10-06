import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, WidgetAreaMutationErrorV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';

/** Headless Actions use the same personal Artifact writer as mounted pages. */
export function createCliWidgetAreaActionDepsV1(input: Readonly<{
    transport: HomeHubArtifactTransportV1; scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
}>): Pick<ActionExecutorDeps, 'widgetSurfaceActions'> {
    const area = createWidgetAreaActionPortV1(surface => {
        if (!input.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired');
        if (surface.serverId !== input.scope.serverId || surface.accountId !== input.scope.accountId) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        if (surface.owner.kind === 'project') throw new WidgetAreaMutationErrorV1('widget_project_source_unavailable');
        return createWidgetSurfaceArtifactPortV1(input.transport, { surface, isCurrent: input.isCurrent });
    });
    return { widgetSurfaceActions: { pluginArea: area, project: area } };
}
