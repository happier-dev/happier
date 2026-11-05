import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetAreaLayoutArtifactPortV1, resolveHostWidgetAreaPresetsV1, USAGE_WIDGET_PRESET_IDS, WidgetAreaMutationErrorV1, type WidgetAreaPresetV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { LazyActionAccountContext } from './actionAccountContext';
import { selectMountedWidgetAreaLayout } from '@/sync/domains/widgets/widgetAreaLayoutSelection';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';

/** Account Artifact transport is shared with Home/WorkBoard; area identity never comes from page context. */
export function createWidgetAreaActionDepsV1(account: LazyActionAccountContext | null | undefined, resolvePresets?: (surface: WidgetSurfaceRefV1) => readonly WidgetAreaPresetV1[] | undefined, isCurrent?: () => boolean): Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'widgetAreaLayouts' | 'widgetAreaLayoutSelect'> {
    if (!account) return {};
    // Inbox replay and mounted first edits consume the same host layout producer.
    // A mount may localize or seed its defaults; callers never supply preset items.
    const presetsFor = (surface: WidgetSurfaceRefV1) => resolvePresets?.(surface)
        ?? resolveHostWidgetAreaPresetsV1(surface, Object.fromEntries(USAGE_WIDGET_PRESET_IDS.map(id => [id, t(`usage.presets.${id}`)])) as Record<typeof USAGE_WIDGET_PRESET_IDS[number], string>);
    const areaPort = (surface: WidgetSurfaceRefV1) => {
        account.assertCurrent();
        if (!areServerProfileIdentifiersEquivalent(surface.serverId, account.serverId) || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetSurfaceArtifactPortV1(account.homeHubArtifactTransport, { surface, presets: presetsFor(surface),
            isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
    };
    const area = createWidgetAreaActionPortV1(areaPort);
    const run = async <T>(operation: () => Promise<T>) => {
        try { return await operation(); }
        catch (error) {
            if (error instanceof WidgetAreaMutationErrorV1) return { ok: false as const, errorCode: error.code, error: error.code };
            // Artifact HTTP refusals are known non-commits; retain their typed code instead of
            // allowing the generic executor catch to turn them into an unknown action failure.
            if (error instanceof HappyError && error.code && typeof error.status === 'number'
                && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
                return { ok: false as const, errorCode: error.code, error: error.message };
            }
            throw error;
        }
    };
    const areaDeps = { widgetSurfaceActions: { pluginArea: area, project: area, corePage: area } };
    const list = 'list' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.list : undefined;
    const remove = 'delete' in account.homeHubArtifactTransport ? account.homeHubArtifactTransport.delete : undefined;
    const dashboard = (surface: Parameters<typeof createWidgetAreaLayoutArtifactPortV1>[1]['surface']) => {
        account.assertCurrent();
        if (typeof list !== 'function' || typeof remove !== 'function') throw new WidgetAreaMutationErrorV1('widget_layouts_unavailable');
        if (!areServerProfileIdentifiersEquivalent(surface.serverId, account.serverId) || surface.accountId !== account.accountId && !(surface.owner.kind === 'project' && surface.artifactId)) throw new WidgetAreaMutationErrorV1('widget_area_owner_mismatch');
        return createWidgetAreaLayoutArtifactPortV1({ ...account.homeHubArtifactTransport, list, delete: remove }, { surface, presets: presetsFor(surface), isCurrent: () => account.accountLifetime.isCurrent() && (isCurrent?.() ?? true) });
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
