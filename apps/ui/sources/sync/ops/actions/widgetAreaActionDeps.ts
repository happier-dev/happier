import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaLayoutArtifactPortV1, WidgetAreaMutationErrorV1, type WidgetAreaPresetV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { LazyActionAccountContext } from './actionAccountContext';
import { selectMountedWidgetAreaLayout } from '@/components/widgets/area/widgetAreaLayoutSelection';

/** Account Artifact transport is shared with Home/WorkBoard; area identity never comes from page context. */
export function createWidgetAreaActionDepsV1(account: LazyActionAccountContext | null | undefined, resolvePresets?: (surface: WidgetSurfaceRefV1) => readonly WidgetAreaPresetV1[] | undefined, isCurrent?: () => boolean): Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'widgetAreaLayouts' | 'widgetAreaLayoutSelect'> {
    if (!account) return {};
    const areaPort = (surface: WidgetSurfaceRefV1) => {
        account.assertCurrent();
        if (surface.serverId !== account.serverId || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetSurfaceArtifactPortV1(account.homeHubArtifactTransport, { surface, presets: resolvePresets?.(surface),
            isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
    };
    const area = createWidgetAreaActionPortV1(areaPort);
    const run = async <T>(operation: () => Promise<T>) => {
        try { return await operation(); }
        catch (error) { if (error instanceof WidgetAreaMutationErrorV1) return { ok: false as const, errorCode: error.code, error: error.code }; throw error; }
    };
    const areaDeps = { widgetSurfaceActions: { pluginArea: area, project: area, corePage: area } };
    const list = 'list' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.list : undefined;
    const remove = 'delete' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.delete : undefined;
    const dashboard = (surface: Parameters<typeof createWidgetAreaLayoutArtifactPortV1>[1]['surface']) => {
        account.assertCurrent();
        if (typeof list !== 'function' || typeof remove !== 'function') throw new WidgetAreaMutationErrorV1('widget_layouts_unavailable');
        if (surface.serverId !== account.serverId || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetAreaLayoutArtifactPortV1({ ...account.homeHubArtifactTransport, list, delete: remove }, { surface, presets: resolvePresets?.(surface), isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
    };
    return { ...areaDeps, widgetAreaLayoutSelect: (surface, _context, signal) => {
        account.assertCurrent();
        return selectMountedWidgetAreaLayout(surface, signal);
    }, widgetAreaLayouts: {
        reset: (args, _context, signal) => run(() => areaPort(args.surface).resetPreset(args.expectedRevision, signal)),
        undo: (capture, _context, signal) => run(() => areaPort(capture.surface).undoReset(capture, signal)),
        list: (args, _context, signal) => run(() => dashboard(args.surface).list(signal)),
        create: (args, _context, signal) => run(() => dashboard(args.surface).create(args, signal)),
        rename: (args, _context, signal) => run(() => dashboard(args.surface).rename(args, signal)),
        delete: (args, _context, signal) => run(() => dashboard(args.surface).delete(args, signal)),
        reorder: (args, _context, signal) => run(() => dashboard(args.surface).reorder(args, signal)),
    } };
}
