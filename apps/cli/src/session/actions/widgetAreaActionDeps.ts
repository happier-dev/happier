import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaLayoutArtifactPortV1, WidgetAreaMutationErrorV1, type WidgetAreaPresetV1 } from '@happier-dev/protocol/widgets/widgetSurfaceArtifactV1';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import type { WorkBoardArtifactTransportV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';

/** Headless Actions use the same personal Artifact writer as mounted pages. */
export function createCliWidgetAreaActionDepsV1(input: Readonly<{
    transport: HomeHubArtifactTransportV1 & Partial<Pick<WorkBoardArtifactTransportV1, 'list' | 'delete'>>; scope: Readonly<{ serverId: string; accountId: string }>;
    isCurrent(): boolean;
    resolvePresets?: (surface: WidgetSurfaceRefV1) => readonly WidgetAreaPresetV1[] | undefined;
}>): Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'widgetAreaLayouts'> {
    const areaPort = (surface: WidgetSurfaceRefV1) => {
        if (!input.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired');
        if (surface.serverId !== input.scope.serverId || surface.accountId !== input.scope.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetSurfaceArtifactPortV1(input.transport, { surface, presets: input.resolvePresets?.(surface), isCurrent: input.isCurrent });
    };
    const area = createWidgetAreaActionPortV1(areaPort);
    const run = async <T>(operation: () => Promise<T>) => {
        try { return await operation(); }
        catch (error) { if (error instanceof WidgetAreaMutationErrorV1) return { ok: false as const, errorCode: error.code, error: error.code }; throw error; }
    };
    const areaDeps = { widgetSurfaceActions: { pluginArea: area, project: area, corePage: area } };
    const list = input.transport.list;
    const remove = input.transport.delete;
    const dashboard = (surface: Parameters<typeof createWidgetAreaLayoutArtifactPortV1>[1]['surface']) => {
        if (!input.isCurrent()) throw new WidgetAreaMutationErrorV1('widget_area_scope_retired');
        if (!list || !remove) throw new WidgetAreaMutationErrorV1('widget_layouts_unavailable');
        const transport = { ...input.transport, list, delete: remove };
        if (surface.serverId !== input.scope.serverId || surface.accountId !== input.scope.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetAreaLayoutArtifactPortV1(transport, { surface, presets: input.resolvePresets?.(surface), isCurrent: input.isCurrent });
    };
    return { ...areaDeps, widgetAreaLayouts: {
        reset: (args, _context, signal) => run(() => areaPort(args.surface).resetPreset(args.expectedRevision, signal)),
        undo: (capture, _context, signal) => run(() => areaPort(capture.surface).undoReset(capture, signal)),
        list: (args, _context, signal) => run(() => dashboard(args.surface).list(signal)),
        create: (args, _context, signal) => run(() => dashboard(args.surface).create(args, signal)),
        rename: (args, _context, signal) => run(() => dashboard(args.surface).rename(args, signal)),
        delete: (args, _context, signal) => run(() => dashboard(args.surface).delete(args, signal)),
        reorder: (args, _context, signal) => run(() => dashboard(args.surface).reorder(args, signal)),
    } };
}
