import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, type WidgetAreaPresetV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { MACHINE_BUILTIN_WIDGET_IDS_V1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import type { WidgetAreaPort } from '@/components/widgets/area/useWidgetAreaLayout';
import { getDemoModeServerId, isSeededDemoHome } from './enterExitDemoMode';

/** The real preset/layout reader over an empty local Artifact transport; no network or writes. */
export function createDemoMachinesWidgetBinding(presets: readonly WidgetAreaPresetV1[]) {
    const serverId = getDemoModeServerId();
    if (!serverId) return null;
    const surface: WidgetSurfaceRefV1 = { serverId, accountId: 'demo-home',
        owner: { kind: 'corePage', pageId: 'machines', area: 'main', layoutId: presets[0]?.id } };
    const refuse = async (): Promise<never> => { throw new Error('Demo machine layout is read only'); };
    const actions = createWidgetAreaActionPortV1(target => createWidgetSurfaceArtifactPortV1({
        read: async () => null, create: refuse, update: refuse,
    }, { surface: target, presets, isCurrent: () => isSeededDemoHome(serverId) }));
    const port: WidgetAreaPort = { surface, execute: async (operation, signal) => {
        if (operation.actionId !== 'widgets.item.list' || !isSeededDemoHome(serverId))
            return { ok: false, errorCode: 'widget_area_unavailable', error: 'widget_area_unavailable' };
        const result = await actions.read(surface, {}, signal);
        if ('ok' in result) return result;
        return { ok: true, result: { ...result, canEdit: false } };
    } };
    const executeLayoutAction = async (actionId: Extract<ActionId, `widgets.area.layout.${string}`>): Promise<ActionExecuteResult> =>
        actionId === 'widgets.area.layout.list' && isSeededDemoHome(serverId)
            ? { ok: true, result: { surface, layouts: [] } }
            : { ok: false, errorCode: 'widget_area_unavailable', error: 'widget_area_unavailable' };
    return { surface, port, executeLayoutAction };
}

/** Only the local machine built-ins can read the demo preset without an authenticated viewer. */
export function isDemoMachineWidgetRead(surface: WidgetSurfaceRefV1, definition: WidgetInstanceV1['definition']): boolean {
    return isDemoMachinesSurfaceRead(surface)
        && definition.kind === 'builtin' && MACHINE_BUILTIN_WIDGET_IDS_V1.some(id => id === definition.id);
}

export function isDemoMachinesSurfaceRead(surface: WidgetSurfaceRefV1): boolean {
    return isSeededDemoHome(surface.serverId) && surface.accountId === 'demo-home'
        && surface.owner.kind === 'corePage' && surface.owner.pageId === 'machines' && surface.owner.area === 'main';
}
