import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildWidgetAreaActionInputV1, PluginUiWidgetAreaResultV1Schema, pluginUiWidgetAreaOperationHasOutwardEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { WidgetSurfaceRefV1Schema, WidgetSurfaceReadV1Schema, readWidgetActionSurfaceV1, type WidgetAreaPresetV1, type WidgetAreaPresetUndoV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { widgetProvidedContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import type { WidgetAreaPort } from './useWidgetAreaLayout';
import { createWidgetAreaSelectionReadHandoff, useWidgetAreaLayoutSelectionOwner } from './widgetAreaLayoutSelection';
import { widgetAreaLayoutBaseSurface, type WidgetAreaLayoutSelectionOwner } from '@/sync/domains/widgets/widgetAreaLayoutSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** A core page supplies defaults and context, while the existing Account area owner keeps its edits. */
export function useCorePageWidgetAreaBinding(input: Readonly<{
    serverId: string; pageId: string; area: string; preset?: WidgetAreaPresetV1; presets?: readonly WidgetAreaPresetV1[]; context: WidgetSurfaceContext;
    /** Route intent is admitted before the first read, never applied as a later visual selection. */
    initialLayoutId?: string | null;
    /** A route may record the acknowledged selection; it is not another selected-layout owner. */
    onSelectLayout?: (layoutId: string) => void;
}>): Readonly<{
    surface: WidgetSurfaceRefV1 | null; port: WidgetAreaPort | null; context: WidgetSurfaceContext;
    resetPreset(target?: WidgetSurfaceRefV1): Promise<ActionExecuteResult>;
    undoReset(capture: WidgetAreaPresetUndoV1): Promise<ActionExecuteResult>;
    listLayouts(): Promise<ActionExecuteResult>;
    createLayout(layoutId: string, name: string): Promise<ActionExecuteResult>;
    selectLayout(layoutId: string): Promise<ActionExecuteResult>;
    executeLayoutAction(actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown): Promise<ActionExecuteResult>;
}> {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = lifetime?.scope ?? null;
    const [selected, setSelected] = React.useState<Readonly<{ serverId: string; accountId: string; pageId: string; area: string; layoutId?: string; routeLayoutId?: string | null }> | null>(null);
    const layoutId = selected && viewer && areServerProfileIdentifiersEquivalent(selected.serverId, viewer.serverId) && selected.accountId === viewer.accountId
        && selected?.pageId === input.pageId && selected.area === input.area && selected.routeLayoutId === input.initialLayoutId
        ? selected.layoutId : input.initialLayoutId ?? input.preset?.id ?? input.presets?.[0]?.id;
    const surface = React.useMemo((): WidgetSurfaceRefV1 | null => {
        if (!lifetime?.isCurrent() || !selectActiveServerAccountScopeForServer(viewer, input.serverId)) return null;
        return WidgetSurfaceRefV1Schema.parse({ serverId: lifetime.scope.serverId, accountId: lifetime.scope.accountId,
            owner: { kind: 'corePage', pageId: input.pageId, area: input.area, ...(layoutId ? { layoutId } : {}) } });
    }, [input.area, input.pageId, layoutId, input.serverId, lifetime, viewer]);
    const bindingIdentity = React.useMemo(() => ({}), [input.context, input.onSelectLayout, input.preset, input.presets, surface]);
    const liveBinding = React.useRef(bindingIdentity);
    liveBinding.current = bindingIdentity;
    // Changing layouts retires its data binding, never the mounted page's layout inventory or next selection.
    const selectionIdentity = React.useMemo(() => ({}), [input.serverId, input.pageId, input.area, lifetime]);
    const liveSelection = React.useRef(selectionIdentity);
    liveSelection.current = selectionIdentity;
    const [readHandoff] = React.useState(() => createWidgetAreaSelectionReadHandoff<ActionExecuteResult>());
    const handoffBinding = React.useMemo(() => ({}), [input.context, input.preset, input.presets, lifetime]);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; readHandoff.cancel(); }; }, [readHandoff]);
    const binding = React.useMemo(() => {
        const isCurrent = () => mounted.current && liveBinding.current === bindingIdentity && lifetime?.isCurrent() === true;
        const isSelectionCurrent = () => mounted.current && liveSelection.current === selectionIdentity && lifetime?.isCurrent() === true;
        const failed = () => ({ ok: false as const, errorCode: 'widget_area_scope_retired', error: 'widget_area_scope_retired' });
        const resolvePresets = (target: WidgetSurfaceRefV1) => surface && areServerProfileIdentifiersEquivalent(target.serverId, surface.serverId) && target.accountId === surface.accountId
            && target.owner.kind === 'corePage' && target.owner.pageId === input.pageId && target.owner.area === input.area
            ? input.presets ?? (input.preset ? [input.preset] : []) : undefined;
        const execute = async (actionId: ActionId, args: unknown, signal?: AbortSignal, context = input.context, current = isCurrent) => {
            if (!surface || !lifetime || !current() || signal?.aborted) return failed();
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!current() || signal?.aborted) return failed();
            const target = readWidgetActionSurfaceV1(args) ?? surface;
            return createDefaultActionExecutor({ resolveWidgetAreaPresets: resolvePresets, widgetAreaIsCurrent: current }).execute(actionId, args, {
                surface: 'ui', actionCaller: { kind: 'host' }, serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId, signal, widgetAreaContext: { surface: target, values: widgetProvidedContext(context) },
            });
        };
        const executeLayoutAction = (actionId: Extract<ActionId, `widgets.area.layout.${string}`>, args: unknown) =>
            execute(actionId, args, undefined, input.context, isSelectionCurrent);
        const port: WidgetAreaPort | null = surface ? { execute: async (operation, signal, admitted) => {
            const target = admitted?.surface ?? surface;
            if (!sameStrictJsonValue(widgetAreaLayoutBaseSurface(target), widgetAreaLayoutBaseSurface(surface)))
                return { ok: false, errorCode: 'widget_area_owner_mismatch', error: 'widget_area_owner_mismatch' };
            const offered = operation.actionId === 'widgets.item.list' && (admitted?.context ?? input.context) === input.context
                ? readHandoff.take(target, handoffBinding, signal) : null;
            const result = await offered ?? await execute(operation.actionId,
                buildWidgetAreaActionInputV1(operation, target), signal, admitted?.context);
            if ((!isCurrent() || signal?.aborted) && !(result.ok && pluginUiWidgetAreaOperationHasOutwardEffectV1(operation))) return failed();
            const parsed = PluginUiWidgetAreaResultV1Schema.safeParse(result);
            return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_widget_area_result', error: 'invalid_widget_area_result' };
        } } : null;
        const selectionOwner: WidgetAreaLayoutSelectionOwner | null = surface ? { surface, isCurrent: isSelectionCurrent, providedContext: widgetProvidedContext(input.context),
            read: (target, signal) => {
                const defaultId = input.preset?.id ?? input.presets?.[0]?.id;
                const destination = target.owner.kind === 'corePage' && !target.owner.layoutId && defaultId
                    ? { ...target, owner: { ...target.owner, layoutId: defaultId } } : target;
                return readHandoff.offer(destination, handoffBinding, signal, readSignal =>
                    execute('widgets.item.list', { surface: destination }, readSignal, input.context, isSelectionCurrent));
            },
            select: target => {
                if (target.owner.kind === 'corePage') setSelected({ serverId: target.serverId, accountId: target.accountId,
                    pageId: input.pageId, area: input.area, layoutId: target.owner.layoutId, routeLayoutId: input.initialLayoutId });
                if (target.owner.kind === 'corePage' && target.owner.layoutId) input.onSelectLayout?.(target.owner.layoutId);
            },
        } : null;
        return { selectionOwner, port, resetPreset: async (target = surface) => {
            const read = await execute('widgets.item.list', { surface: target });
            const parsed = read.ok ? WidgetSurfaceReadV1Schema.safeParse(read.result) : null;
            return parsed?.success ? execute('widgets.area.layout.reset', { surface: target, expectedRevision: parsed.data.revision ?? null }) : read;
        },
            listLayouts: () => executeLayoutAction('widgets.area.layout.list', { surface }),
            createLayout: (layoutId: string, name: string) => executeLayoutAction('widgets.area.layout.create', { surface, layoutId, name, fromSurface: surface }),
            selectLayout: async (layoutId: string) => {
                if (!surface || surface.owner.kind !== 'corePage') return failed();
                return executeLayoutAction('widgets.area.layout.select', { surface: { ...surface, owner: { ...surface.owner, layoutId } } });
            },
            executeLayoutAction,
            undoReset: (capture: WidgetAreaPresetUndoV1) => execute('widgets.area.layout.undo', { capture }) };
    }, [bindingIdentity, handoffBinding, readHandoff, selectionIdentity, input.area, input.context, input.initialLayoutId, input.onSelectLayout, input.pageId, input.preset, input.presets, lifetime, surface]);
    const currentLayoutAction = React.useRef(binding.executeLayoutAction);
    currentLayoutAction.current = binding.executeLayoutAction;
    // The inventory addresses the base area across selected views. Keep its executor
    // stable while each invocation still uses the latest admitted binding and scope.
    const executeLayoutAction = React.useCallback<typeof binding.executeLayoutAction>(
        (actionId, args) => currentLayoutAction.current(actionId, args), [input.preset, input.presets]);
    useWidgetAreaLayoutSelectionOwner(binding.selectionOwner);
    return React.useMemo(() => {
        const { selectionOwner: _selectionOwner, ...operations } = binding;
        return { ...operations, executeLayoutAction, surface, context: input.context };
    }, [binding, executeLayoutAction, input.context, surface]);
}
