import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, WidgetAreaMutationErrorV1 } from '@happier-dev/protocol/widgets';
import type { LazyActionAccountContext } from './actionAccountContext';

/** Account Artifact transport is shared with Home/WorkBoard; area identity never comes from page context. */
export function createWidgetAreaActionDepsV1(account: LazyActionAccountContext | null | undefined): Pick<ActionExecutorDeps, 'widgetSurfaceActions'> {
    if (!account) return {};
    const area = createWidgetAreaActionPortV1(surface => {
        account.assertCurrent();
        if (surface.serverId !== account.serverId || surface.accountId !== account.accountId) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        // Lane 12 has not published its portable Project Source producer. An exact Workspace is not that source.
        if (surface.owner.kind === 'project') throw new WidgetAreaMutationErrorV1('widget_project_source_unavailable');
        return createWidgetSurfaceArtifactPortV1(account.homeHubArtifactTransport, { surface, isCurrent: account.accountLifetime.isCurrent });
    });
    return { widgetSurfaceActions: { pluginArea: area, project: area } };
}
